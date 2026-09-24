import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/client.js';

test('DSH runs in the component Host; tool callbacks can reenter the same runtime', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'conest-host-'));
  const client = new BridgeClient({ workerFile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)),
    workspaceRoot: workspace, startupTimeoutMs: 30_000, shutdownTimeoutMs: 5_000 });
  t.after(async () => { await client.stop(); await rm(workspace, { recursive: true, force: true }); });
  await writeFile(path.join(workspace, 'evidence.txt'), 'HOST_SHARED_SERVICE_OK\n');
  const runtime = await client.start();
  const setup = { workspaceRoot: workspace, enableBridgeProofAdapter: true };
  const support = await client.extension<{ pid: number; parentPid: number }>({ operation: 'start', setup });
  assert.equal(support.pid, runtime.pid);
  assert.equal(support.parentPid, process.pid);
  assert.notEqual(support.pid, process.pid);
  let callbacks = 0, events = 0;
  const result = await client.extension<any>({ operation: 'runHarnessAgent', setup,
    args: { task: 'PROOF:BASH:', sessionKey: 'process-test', provider: 'bridge-proof', model: 'test', timeoutMs: 10_000,
      hostTools: [{ name: 'bash', description: 'Admitted host callback', parameters: { type: 'object', additionalProperties: true } }] },
    callbacks: {
      event() { events++; },
      async tool(request) {
        assert.equal(request.name, 'bash'); callbacks++;
        const found = await client.invoke({ capability: 'knowledge_search', args: { query: 'HOST_SHARED_SERVICE_OK' },
          taskId: 'nested', callId: request.callId, subject: 'process-test', principal: { kind: 'agent', agentId: 'main' },
          workspaceRoot: workspace, permissions: ['workspace:read'] });
        assert.equal((found.value as any).totalMatches, 1);
        return { content: [{ type: 'text', text: 'HOST_CALLBACK_OK' }] };
      },
    },
  });
  assert.match(result.finalText, /HOST_CALLBACK_OK/);
  assert.equal(callbacks, 1); assert.ok(events > 0);
  assert.equal((await client.status()).pid, support.pid);

  const cancelled = new AbortController();
  const entered = Promise.withResolvers<void>();
  const run = client.extension({ operation: 'runHarnessAgent', setup, signal: cancelled.signal,
    args: { task: 'PROOF:BASH:', sessionKey: 'cancel-test', provider: 'bridge-proof', model: 'test', timeoutMs: 10_000,
      hostTools: [{ name: 'bash', description: 'Cancelable callback', parameters: { type: 'object', additionalProperties: true } }] },
    callbacks: { event() {}, async tool(_request, signal) {
      entered.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  });
  const rejected = assert.rejects(run);
  await entered.promise; cancelled.abort(); await rejected;
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await client.status()).pid, support.pid, 'Cooperative cancellation must preserve Host');
  await assert.rejects(client.extension({ operation: 'start', setup: { workspaceRoot: os.tmpdir() } }), /Host workspace/);

  const pendingTool = Promise.withResolvers<void>();
  const releaseTool = Promise.withResolvers<void>();
  const abandoned = client.extension({ operation: 'runHarnessAgent', setup,
    args: { task: 'PROOF:BASH:', sessionKey: 'retired-process', provider: 'bridge-proof', model: 'test', timeoutMs: 10_000,
      hostTools: [{ name: 'bash', description: 'Late callback', parameters: { type: 'object' } }] },
    callbacks: { event() {}, async tool() {
      pendingTool.resolve(); await releaseTool.promise;
      return { content: [{ type: 'text', text: 'RETIRED_RESULT' }] };
    } },
  });
  const abandonedFailure = assert.rejects(abandoned);
  await pendingTool.promise;
  await client.stop(); await abandonedFailure;
  const replacement = await client.start();
  assert.notEqual(replacement.pid, support.pid);
  releaseTool.resolve();
  const next = await client.extension<any>({ operation: 'runHarnessAgent', setup,
    args: { task: 'PROOF:BASH:', sessionKey: 'replacement-process', provider: 'bridge-proof', model: 'test', timeoutMs: 10_000,
      hostTools: [{ name: 'bash', description: 'Current callback', parameters: { type: 'object' } }] },
    callbacks: { event() {}, tool() { return { content: [{ type: 'text', text: 'CURRENT_RESULT' }] }; } },
  });
  assert.match(next.finalText, /CURRENT_RESULT/);
  assert.doesNotMatch(next.finalText, /RETIRED_RESULT/);
});
