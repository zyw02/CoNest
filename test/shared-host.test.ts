import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { borrowHost } from '../src/shared-host.js';
import { fixture, hasCode } from './helpers.js';

test('separate host registries share one worker and borrowed cleanup cannot stop its service', async context => {
  const { workspace, configFile } = await fixture(context);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace }));
  const options = { configFile, workerFile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)), startupTimeoutMs: 15_000, shutdownTimeoutMs: 1000 };
  const identity = randomUUID();
  const service = borrowHost(identity, options, 5000, 32);
  const tools = borrowHost(identity, options, 5000, 32);
  try {
    assert.equal(service.host, tools.host);
    assert.equal(service.scopes, tools.scopes);
    assert.equal(service.contextDiagnostics, tools.contextDiagnostics);
    tools.contextDiagnostics.record('timeout', 50);
    assert.equal(service.contextDiagnostics.snapshot().counts.timeout, 1, 'A status registry must see request-time context outcomes');
    const started = await service.startService();
    assert.equal(tools.serviceRunning(), true);
    assert.equal((await tools.host.refresh()).pid, started.pid);
    await tools.release();
    assert.equal(tools.serviceRunning(), true, 'Borrowed cleanup does not terminate the service lifetime');
    assert.equal((await service.host.refresh()).pid, started.pid);
    await service.stopService();
    assert.equal(tools.serviceRunning(), false);
    await assert.rejects(service.host.refresh(), hasCode('BRIDGE_STOPPING'));
  } finally { await tools.release(); await service.release(); }
});
