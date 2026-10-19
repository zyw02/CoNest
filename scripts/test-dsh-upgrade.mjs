import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeClient } from '../dist/client.js';
import { SessionId, sessionEventsSince } from '../dist/adapters/dsh-session.js';
import { startComposition } from '../dist/studio/composition.js';

const args = process.argv.slice(2), flags = {};
while (args.length) {
  const key = args.shift(), value = args.shift();
  assert(['--legacy-worker', '--current-worker'].includes(key) && value && !flags[key],
    'Usage: test-dsh-upgrade.mjs --legacy-worker OLD_DIST/worker.js --current-worker NEW_DIST/worker.js');
  flags[key] = path.resolve(value);
}
assert(flags['--legacy-worker'] && flags['--current-worker'], 'Supply both independently built SDK workers');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conest-dsh-upgrade-')));
const workspaceRoot = path.join(root, 'workspace');
await mkdir(workspaceRoot);
const setup = { workspaceRoot, sessionPersistenceRoot: path.join(root, 'sessions'), enableBridgeProofAdapter: true };
let sessionId;
try {
  for (const [label, workerFile] of [['legacy', flags['--legacy-worker']], ['current', flags['--current-worker']]]) {
    const client = new BridgeClient({ workerFile, workspaceRoot, startupTimeoutMs: 30_000, shutdownTimeoutMs: 5_000 });
    try {
      await client.start();
      const result = await client.extension({ operation: 'runHarnessAgent', setup,
        args: { task: `PROOF:IMAGE:upgrade-${label}-history`, sessionKey: 'dsh-upgrade', provider: 'bridge-proof', model: 'test', timeoutMs: 15_000 },
        callbacks: { event() {} } });
      assert.match(result.finalText, /DSH_IMAGE_INPUT_MISSING/);
      if (sessionId) assert.equal(result.sessionId, sessionId, 'The upgraded worker must resume the existing session');
      sessionId = result.sessionId;
    } finally { await client.stop(); }
  }
  const running = await startComposition(setup);
  try {
    const handle = await running.context.agents.resume({ resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: 'bridge-proof', model: 'test', maxTokens: 256 } });
    const history = JSON.stringify(sessionEventsSince(handle.agent.session, 0));
    assert.ok(history.includes('upgrade-legacy-history'), 'Legacy history must survive migration');
    assert.ok(history.includes('upgrade-current-history'), 'The resumed session must persist its new turn');
    await handle.dispose();
  } finally { await running.dispose(); }
  console.log(JSON.stringify({ passed: true, legacyHistoryRetained: true, upgradedTurnPersisted: true, paidModelCalls: 0 }));
} finally { await rm(root, { recursive: true, force: true }); }
