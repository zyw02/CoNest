import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/client.js';
import { PROTOCOL_VERSION, type Progress } from '../src/types.js';

test('the supervised worker serves a real DSH search and exits cleanly', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-client-'));
  await writeFile(path.join(workspace, 'source.txt'), 'supervised process marker\n', 'utf8');
  const workerFile = path.resolve(fileURLToPath(new URL('../dist/worker.js', import.meta.url)));
  const progress: Progress[] = [];
  const client = new BridgeClient({
    workerFile,
    workspaceRoot: workspace,
    startupTimeoutMs: 15_000,
    shutdownTimeoutMs: 5_000,
  });
  try {
    const started = await client.start();
    assert.equal(started.state, 'ready');
    assert.notEqual(started.pid, process.pid);

    const result = await client.invoke({
      capability: 'knowledge_search',
      args: { query: 'supervised process marker' },
      taskId: 'worker-search-task',
      callId: 'worker-search-call',
      subject: 'integration-test',
      principal: { kind: 'agent', agentId: 'main' },
      workspaceRoot: workspace,
      permissions: ['workspace:read'],
      onProgress: event => progress.push(event),
    });
    assert.equal((result.value as { totalMatches?: unknown }).totalMatches, 1);
    assert.ok(progress.some(event => event.state === 'running'));
    assert.ok(progress.some(event => event.state === 'completed'));
    assert.equal((await client.status()).tasks, 0);
  } finally {
    await client.stop();
    assert.equal(client.getState().state, 'stopped');
    await rm(workspace, { recursive: true, force: true });
  }
});

test('cancellation after authorization releases the task before a caller can retry it', async () => {
  const client = new BridgeClient({ workerFile: 'unused', startupTimeoutMs: 1_000, shutdownTimeoutMs: 1_000 });
  const abort = new AbortController();
  const releaseStarted = Promise.withResolvers<void>();
  const finishRelease = Promise.withResolvers<void>();
  let leased = false;
  let first = true;
  Reflect.set(client, 'state', 'ready');
  Reflect.set(client, 'child', {});
  Reflect.set(client, 'request', async (method: string) => {
    if (method === 'authorize') {
      if (leased) throw new Error('DUPLICATE_TASK');
      leased = true;
      if (first) { first = false; abort.abort(new Error('caller cancelled')); }
      return { token: 'grant', expiresAt: Date.now() + 5_000, generation: 'revision' };
    }
    if (method === 'release') {
      releaseStarted.resolve();
      await finishRelease.promise;
      leased = false;
      return { released: true };
    }
    if (method === 'invoke') return { value: 'completed', generation: 'revision' };
    throw new Error('Unexpected method ' + method);
  });
  const input = {
    capability: 'knowledge_search', args: { query: 'marker' }, taskId: 'same-task', callId: 'first-call',
    subject: 'test', principal: { kind: 'agent' as const, agentId: 'main' },
    workspaceRoot: '/unused', permissions: ['workspace:read' as const],
  };
  const interrupted = client.invoke({ ...input, signal: abort.signal });
  await releaseStarted.promise;
  let finished = false;
  void interrupted.catch(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'the cancellation must wait for grant release');
  finishRelease.resolve();
  await assert.rejects(interrupted, /caller cancelled/);
  assert.equal((await client.invoke({ ...input, callId: 'retry-call' })).value, 'completed');
});

async function delayedAuthorizationClient(t: test.TestContext) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'conest-delayed-authorization-'));
  const workerFile = path.join(workspace, 'worker.mjs');
  // A real IPC peer holds authorization until the next status request, so the
  // parent can advance its timeout clock without depending on machine speed.
  await writeFile(workerFile, `
    import { createInterface } from 'node:readline';
    let held;
    let invocations = 0;
    const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\\n');
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method === 'status') {
        if (held) {
          reply(held.id, { token: 'grant', generation: 'revision', expiresAt: Date.now() + 60000 });
          held = undefined;
        }
        reply(request.id, { protocol: ${PROTOCOL_VERSION}, state: 'ready', pid: process.pid, invocations });
      } else if (request.method === 'authorize') {
        held = request;
        process.stderr.write('AUTHORIZATION_HELD\\n');
      } else if (request.method === 'invoke') {
        reply(request.id, { value: ++invocations, generation: 'revision' });
      } else {
        reply(request.id, request.method === 'release' ? { released: true } : {});
        if (request.method === 'shutdown') break;
      }
    }
  `);
  const held = Promise.withResolvers<void>();
  const client = new BridgeClient({ workerFile, workspaceRoot: workspace,
    startupTimeoutMs: 10_000, shutdownTimeoutMs: 1_000,
    onLog: (_level, message) => { if (message === 'AUTHORIZATION_HELD') held.resolve(); },
  });
  t.after(async () => {
    t.mock.timers.reset();
    await client.stop();
    await rm(workspace, { recursive: true, force: true });
  });
  await client.start();
  return { client, held: held.promise, input: {
    capability: 'knowledge_search', args: { query: 'marker' }, taskId: 'task', callId: 'call',
    subject: 'test', principal: { kind: 'agent' as const, agentId: 'main' },
    workspaceRoot: workspace, permissions: ['workspace:read' as const],
  } };
}

test('authorization can survive a slow IPC reply without replaying the tool invocation', async t => {
  const { client, held, input } = await delayedAuthorizationClient(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = client.invoke(input);
  void result.catch(() => {});
  await held;
  t.mock.timers.tick(3_001);
  await client.status();
  assert.equal((await result).value, 1);
});

for (const deadline of [false, true]) {
  test(`authorization remains bounded by the ${deadline ? 'caller deadline' : 'IPC timeout'}`, async t => {
    const { client, held, input } = await delayedAuthorizationClient(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const result = client.invoke({ ...input, ...(deadline ? { expiresAt: Date.now() + 1_000 } : {}) });
    const rejected = assert.rejects(result, { code: 'BRIDGE_TIMEOUT' });
    await held;
    t.mock.timers.tick(deadline ? 1_001 : 10_001);
    const status = await client.status();
    await rejected;
    assert.equal(Reflect.get(status, 'invocations'), 0, 'a late authorization must not execute the tool');
  });
}

test('an already expired caller deadline prevents authorization and tool execution', async t => {
  const { client, input } = await delayedAuthorizationClient(t);
  await assert.rejects(client.invoke({ ...input, expiresAt: Date.now() - 1 }), { code: 'AUTHORIZATION_EXPIRED' });
  assert.equal(Reflect.get(await client.status(), 'invocations'), 0);
});
