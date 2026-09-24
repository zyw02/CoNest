import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/client.js';
import type { Progress } from '../src/types.js';

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
