import { fileURLToPath } from 'node:url';
import { SessionId, sessionEventsSince } from '../src/adapters/dsh-session.js';
import { startComposition } from '../src/studio/composition.js';
import { BridgeClient } from '../src/client.js';
import type { AgentRunResult } from '../src/studio/cordis-bridge-host.js';
import { Context, settleFiber } from '../src/adapters/dsh-cordis.js';
import { ToolFs } from '../src/adapters/dsh-filesystem.js';
import { SystemPrompt } from '../src/adapters/dsh-search.js';
import { mountWorkingDirectory } from '../src/adapters/dsh-working-directory.js';
import { fixture } from './helpers.js';
import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  DSH_COMPATIBILITY_RANGE,
  DSH_TESTED_VERSION,
  DSH_TESTED_VERSIONS,
  OPENCLAW_COMPATIBILITY_RANGE,
  OPENCLAW_TESTED_VERSION,
  inspectCompatibility,
  inspectDsh,
  inspectOpenClaw,
} from '../src/compatibility.js';

test('accepts supported OpenClaw releases without requiring the build pin', () => {
  assert.deepEqual(inspectOpenClaw(OPENCLAW_TESTED_VERSION), {
    name: 'OpenClaw', installed: '2026.9.2', supported: OPENCLAW_COMPATIBILITY_RANGE, tested: true,
  });
  assert.equal(inspectOpenClaw('2026.9.5').tested, true);
  assert.equal(inspectOpenClaw('2026.10.0').tested, false);
  assert.throws(() => inspectOpenClaw('2027.1.0'), /outside CoNest's supported range/);
});

test('handles prerelease DSH versions with an explicit adapter range', () => {
  assert.equal(inspectCompatibility('DSH', DSH_TESTED_VERSION, DSH_COMPATIBILITY_RANGE, [DSH_TESTED_VERSION]).tested, true);
  assert.equal(inspectDsh('0.1.0-rc.7').tested, true);
  assert.equal(inspectDsh('0.1.0-rc.8').tested, true);
  assert.equal(inspectDsh('0.1.6-alpha.2').tested, true);
  assert.throws(() => inspectDsh('0.1.5-rc.2'), /outside/);
  assert.throws(() => inspectCompatibility('DSH', '0.2.0', DSH_COMPATIBILITY_RANGE, []), /outside/);
});

test('keeps published compatibility metadata aligned with package discovery metadata', async () => {
  const compatibility = JSON.parse(await readFile('compatibility.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(compatibility.adapters.openclaw.supported, OPENCLAW_COMPATIBILITY_RANGE);
  assert.equal(pkg.peerDependencies.openclaw, OPENCLAW_COMPATIBILITY_RANGE);
  assert.equal(pkg.openclaw.compat.pluginApi, OPENCLAW_COMPATIBILITY_RANGE);
  assert.equal(compatibility.adapters.dsh.supported, DSH_COMPATIBILITY_RANGE);
  assert.deepEqual(compatibility.adapters.dsh.tested, [...DSH_TESTED_VERSIONS]);
  assert.deepEqual(compatibility.adapters.dsh.qualifications.map((entry: { version: string }) => entry.version), [...DSH_TESTED_VERSIONS]);
  assert.equal(compatibility.contracts.runtimeProtocol, 4);
});

test('keeps third-party Agent SDK imports inside adapter modules', async () => {
  const queue = ['src'];
  const violations: string[] = [];
  while (queue.length) {
    const directory = queue.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (!file.startsWith('src/adapters/') && /\.(?:[cm]?ts|[cm]?js)$/.test(file)) {
        const source = await readFile(file, 'utf8');
        if (/\bfrom\s+["'](?:openclaw\/|@deepseek-ai\/)|\bimport\s*\(["'](?:openclaw\/|@deepseek-ai\/)/.test(source)) violations.push(file);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('real JSONL persistence survives composition teardown and cold Agent resume', async t => {
  const f = await fixture(t);
  const workspaceRoot = await realpath(f.workspace);
  const options = { workspaceRoot, sessionPersistenceRoot: path.join(f.root, 'sessions'), enableBridgeProofAdapter: true };
  const agentOptions = { provider: 'bridge-proof', model: 'test', maxTokens: 256 };
  const client = new BridgeClient({ workerFile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)),
    workspaceRoot, startupTimeoutMs: 15_000, shutdownTimeoutMs: 5_000 });
  const turn = (marker: string) => client.extension<AgentRunResult>({ operation: 'runHarnessAgent', setup: options,
    args: { task: `PROOF:IMAGE:${marker}`, sessionKey: 'persistence-compatibility', provider: 'bridge-proof', model: 'test', timeoutMs: 10_000 },
    callbacks: { event() {} } });
  try {
    await client.start();
    const first = await turn('persisted-first-turn');
    assert.match(first.finalText, /DSH_IMAGE_INPUT_MISSING/);
    await client.stop();
    await client.start();
    const second = await turn('persisted-second-turn');
    assert.equal(second.sessionId, first.sessionId);
    assert.match(second.finalText, /DSH_IMAGE_INPUT_MISSING/);
    await client.stop();
    const running = await startComposition(options);
    try {
      const resumed = await running.context.agents.resume({ resumeSessionId: SessionId(first.sessionId), agentOptions });
      const history = JSON.stringify(sessionEventsSince(resumed.agent.session, 0));
      assert.ok(history.includes('persisted-first-turn'));
      assert.ok(history.includes('persisted-second-turn'));
      await resumed.dispose();
    } finally { await running.dispose(); }
  } finally { await client.stop(); }
});

test('working-directory services are released on composition disposal and partial activation failure', async t => {
  const { workspace } = await fixture(t);
  const required = ToolFs.inject.includes('workingDirectory');
  const running = await startComposition({ workspaceRoot: await realpath(workspace) });
  try { assert.equal(!!running.context.get('workingDirectory'), required); }
  finally { await running.dispose(); }
  assert.equal(running.context.get('workingDirectory'), undefined);

  const context = new Context();
  const prompt = await settleFiber(context.plugin(SystemPrompt, {}));
  try {
    if (required) await assert.rejects(mountWorkingDirectory(context, 'relative-directory'), /defaultDirectory must be absolute/);
    else assert.deepEqual(await mountWorkingDirectory(context, 'relative-directory'), []);
    for (const service of ['workingDirectory', 'sessionProjections', 'fs']) assert.equal(context.get(service), undefined);
  } finally { await prompt.dispose(); }
});
