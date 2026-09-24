import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { BridgeRuntime } from '../src/runtime.js';
import { RunScopes } from '../src/run-scope.js';
import { component, fixture, hasCode, request } from './helpers.js';

test('call grants reject identity changes, replay, revocation, expiry, and stale generations', async context => {
  const { workspace } = await fixture(context);
  await writeFile(path.join(workspace, 'evidence.txt'), 'authorization fixture\n');
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace }), () => {});
  try {
    const input = request(workspace, 'knowledge_search', { query: 'authorization' });
    const stolen = runtime.authorize(input);
    await assert.rejects(runtime.invoke({ ...input, subject: 'different-owner', authorization: stolen.token }), hasCode('AUTHORIZATION_MISMATCH'));
    const grant = runtime.authorize(input);
    await runtime.invoke({ ...input, authorization: grant.token });
    await assert.rejects(runtime.invoke({ ...input, authorization: grant.token }), hasCode('AUTHORIZATION_INVALID'));
    assert.equal(runtime.status().grants, 0);
    const revoked = runtime.authorize(input);
    assert.equal(runtime.release(revoked.token), true);
    await assert.rejects(runtime.invoke({ ...input, authorization: revoked.token }), hasCode('AUTHORIZATION_INVALID'));
    assert.throws(() => runtime.authorize({ ...input, expiresAt: Date.now() - 1 }), hasCode('AUTHORIZATION_EXPIRED'));
    assert.throws(() => runtime.authorize({ ...input, permissions: [] }), hasCode('PERMISSION_DENIED'));
    const stale = runtime.authorize(input);
    await runtime.reload(resolveConfig({ workspaceRoot: workspace, maxConcurrent: 2 }));
    await assert.rejects(runtime.invoke({ ...input, authorization: stale.token }), hasCode('STALE_GENERATION'));
    assert.throws(() => runtime.authorize({ ...input, expectedGeneration: stale.generation }), hasCode('STALE_GENERATION'));
    const expires = runtime.authorize({ ...input, expiresAt: Date.now() + 20 });
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(runtime.invoke({ ...input, authorization: expires.token }), hasCode('AUTHORIZATION_INVALID'));
    assert.equal(runtime.status().tasks, 0);
    assert.equal(runtime.status().grants, 0);
    await runtime.reload(resolveConfig({ workspaceRoot: workspace, permissions: [] }));
    assert.deepEqual(runtime.status().capabilities, []);
    assert.throws(() => runtime.authorize(input), hasCode('PERMISSION_DENIED'));
  } finally { await runtime.close(); }
});

test('TTL stops real pending work and cancellation cannot use another call grant', async context => {
  const { root, workspace } = await fixture(context);
  const manifest = await component(root, {
    id: 'bounded-work', version: '1.0.0', description: 'Bounded task fixture', entry: '', requires: {},
    capabilities: [{ name: 'bounded_work', description: 'Wait for cancellation', inputSchema: { type: 'object' }, permissions: ['workspace:read'] }],
  }, `export default {
    inject: ['bridgeCapabilities'],
    apply(ctx) {
      ctx.bridgeCapabilities.register(ctx, 'bounded_work', async (_args, invocation) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 10000);
          invocation.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(invocation.signal.reason);
          }, { once: true });
        });
        throw new Error('The deadline failed to cancel actual work');
      });
    },
  };`);
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace, components: [manifest], taskTtlMs: 100 }), () => {});
  try {
    const input = request(workspace, 'bounded_work');
    const grant = runtime.authorize(input);
    const work = runtime.invoke({ ...input, authorization: grant.token });
    assert.throws(() => runtime.cancel(input.taskId, 'wrong-call-grant'), hasCode('AUTHORIZATION_MISMATCH'));
    await assert.rejects(work, hasCode('TASK_TIMEOUT'));
    assert.equal(runtime.status().tasks, 0);
    assert.equal(runtime.status().active, 0);
    assert.equal(runtime.cancel(input.taskId, grant.token), false);
  } finally { await runtime.close(); }
});

test('host run end and caller abort invalidate retained execution bindings', () => {
  const scopes = new RunScopes(5_000, 8);
  try {
    scopes.observe('call-one', 'run-one');
    const binding = scopes.claim('call-one');
    scopes.endRun('run-one');
    assert.equal(binding.signal.aborted, true);
    assert.throws(() => scopes.claim('call-one'), hasCode('TASK_ENDED'));
    const abort = new AbortController();
    scopes.observe('call-two', 'run-two', abort.signal);
    const second = scopes.claim('call-two');
    abort.abort(new Error('Host cancellation'));
    assert.equal(second.signal.aborted, true);
    assert.throws(() => scopes.claim('call-two'), /Host cancellation/);
    scopes.observe('call-three', 'run-three');
    scopes.claim('call-three');
    assert.throws(() => scopes.claim('call-three'), hasCode('CALL_ALREADY_USED'));
  } finally { scopes.close(); }
});
