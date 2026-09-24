import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { BridgeRuntime, type InvokeRequest } from '../src/runtime.js';
import type { JsonObject, Progress } from '../src/types.js';

test('DSH search and dependent quote verification complete a real workspace flow', async context => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-search-'));
  const otherWorkspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-other-'));
  context.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(otherWorkspace, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(workspace, 'source.txt'), 'alpha marker appears here.\nsecond line\n');
  const progress: Progress[] = [];
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace }), event => progress.push(event));
  try {
    const search = await invoke(runtime, request('knowledge_search', { query: 'alpha marker' }, workspace, 'search'));
    const searchValue = unwrap(search.value);
    assert.equal(searchValue.totalMatches, 1);
    assert.match(JSON.stringify(searchValue.matches), /source\.txt/);

    const verification = await invoke(runtime, request(
      'knowledge_verify', { query: 'alpha marker', quote: 'alpha marker appears here.' }, workspace, 'verify',
    ));
    assert.equal(unwrap(verification.value).verified, true);
    assert.ok(progress.some(event => event.state === 'completed'));

    await assert.rejects(
      invoke(runtime, { ...request('knowledge_search', { query: 'alpha' }, workspace, 'denied'), permissions: [] }),
      (error: unknown) => hasCode(error, 'PERMISSION_DENIED'),
    );
    await assert.rejects(
      invoke(runtime, request('knowledge_verify', { query: 'alpha', quote: 'alpha\nmarker' }, workspace, 'multiline')),
      (error: unknown) => hasCode(error, 'INVALID_ARGUMENTS'),
    );
    await assert.rejects(
      runtime.reload(resolveConfig({ workspaceRoot: otherWorkspace })),
      (error: unknown) => hasCode(error, 'WORKSPACE_RESTART_REQUIRED'),
    );
  } finally {
    await runtime.close();
  }
});

test('queue bounds, cancellation, and generation-pinned reload preserve active work', async context => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-reload-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const manifestFile = path.join(workspace, 'component.json');
  await writeSlowComponent(manifestFile, workspace, '1.0.0');
  const makeConfig = () => resolveConfig({
    workspaceRoot: workspace,
    components: [manifestFile],
    maxConcurrent: 1,
    maxQueued: 1,
    taskTtlMs: 5_000,
  }, workspace);
  const runtime = await BridgeRuntime.create(makeConfig(), () => {});
  try {
    assert.equal(runtime.status().state, 'ready', JSON.stringify(runtime.status().components));
    const first = invoke(runtime, request('slow_check', { delayMs: 700 }, workspace, 'first'));
    const secondRequest = request('slow_check', { delayMs: 700 }, workspace, 'second');
    const secondGrant = runtime.authorize(secondRequest);
    const second = runtime.invoke({ ...secondRequest, authorization: secondGrant.token });
    await assert.rejects(
      invoke(runtime, request('slow_check', { delayMs: 1 }, workspace, 'overflow')),
      (error: unknown) => hasCode(error, 'QUEUE_FULL'),
    );
    assert.equal(runtime.cancel('task-second', secondGrant.token), true);
    await assert.rejects(second, (error: unknown) => hasCode(error, 'TASK_CANCELLED'));

    await writeSlowComponent(manifestFile, workspace, '2.0.0');
    const reloaded = await runtime.reload(makeConfig());
    assert.equal(reloaded.retiredGenerations, 1);
    const next = invoke(runtime, request('slow_check', { delayMs: 1 }, workspace, 'next'));
    assert.equal(unwrap((await first).value).version, '1.0.0');
    assert.equal(unwrap((await next).value).version, '2.0.0');
    assert.equal(runtime.status().retiredGenerations, 0);
  } finally {
    await runtime.close();
  }
});

function request(capability: string, args: JsonObject, workspaceRoot: string, id: string): Omit<InvokeRequest, 'authorization'> {
  return {
    capability, args, workspaceRoot,
    taskId: `task-${id}`, callId: `call-${id}`, subject: 'test',
    principal: { kind: 'agent', agentId: 'main' },
    permissions: ['workspace:read'],
  };
}

async function invoke(runtime: BridgeRuntime, request: Omit<InvokeRequest, 'authorization'>) {
  const grant = runtime.authorize(request);
  return await runtime.invoke({ ...request, authorization: grant.token });
}

function unwrap(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object');
  return value as Record<string, unknown>;
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === code;
}

async function writeSlowComponent(manifestFile: string, directory: string, version: string): Promise<void> {
  const entryName = `component-${version}.js`;
  const entryFile = path.join(directory, entryName);
  await writeFile(entryFile, `export default {
  name: 'slow-fixture',
  inject: ['bridgeCapabilities'],
  apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'slow_check', async (args, invocation) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, args.delayMs);
        const abort = () => { clearTimeout(timer); reject(invocation.signal.reason); };
        if (invocation.signal.aborted) abort();
        else invocation.signal.addEventListener('abort', abort, { once: true });
      });
      return { version: '${version}' };
    });
  },
};\n`);
  await writeFile(manifestFile, JSON.stringify({
    id: 'slow-fixture', version, description: 'Slow lifecycle fixture', entry: `./${entryName}`, requires: {},
    capabilities: [{
      name: 'slow_check', description: 'Wait for a bounded duration', permissions: ['workspace:read'],
      inputSchema: { type: 'object', additionalProperties: false, properties: { delayMs: { type: 'integer', minimum: 0, maximum: 2_000 } }, required: ['delayMs'] },
    }],
  }));
}
