import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openClawApiVersion, openClawContractForVersion, supportsGatewayRuntimePatch, usesLegacyAgentList } from '../src/adapters/openclaw-version.js';
import { SessionId, sessionEventsSince } from '../src/adapters/dsh-session.js';
import { startComposition } from '../src/studio/composition.js';
import { BridgeClient } from '../src/client.js';
import type { AgentRunResult } from '../src/studio/cordis-bridge-host.js';
import { Context, settleFiber } from '../src/adapters/dsh-cordis.js';
import { ToolFs } from '../src/adapters/dsh-filesystem.js';
import { SystemPrompt } from '../src/adapters/dsh-search.js';
import { executeTool, ToolCallId, ToolRuntime } from '../src/adapters/dsh-tools.js';
import { mountWorkingDirectory } from '../src/adapters/dsh-working-directory.js';
import { fixture } from './helpers.js';
import {
  CORDIS_COMPATIBILITY_RANGE,
  DSH_COMPATIBILITY_RANGE,
  DSH_TESTED_VERSION,
  DSH_TESTED_VERSIONS,
  OPENCLAW_COMPATIBILITY_RANGE,
  OPENCLAW_TESTED_VERSION,
  OPENCLAW_TESTED_VERSIONS,
  inspectCompatibility,
  inspectDsh,
  inspectOpenClaw,
} from '../src/compatibility.js';

test('accepts supported OpenClaw releases without requiring the build pin', () => {
  assert.deepEqual(inspectOpenClaw(OPENCLAW_TESTED_VERSION), {
    name: 'OpenClaw', installed: '2026.9.2', supported: OPENCLAW_COMPATIBILITY_RANGE, tested: true,
  });
  assert.equal(inspectOpenClaw('2026.9.5').tested, true);
  for (const version of ['2026.7.1', '2026.7.1-1', '2026.7.1-2', '2026.7.35', '2026.8.1']) assert.equal(inspectOpenClaw(version).installed, version);
  assert.throws(() => inspectOpenClaw('2026.6.1'), /outside/);
  assert.throws(() => inspectOpenClaw('2026.7.1-beta.6'), /prerelease/);
  assert.equal(inspectOpenClaw('2026.10.0').tested, false);
  assert.throws(() => inspectOpenClaw('2027.1.0'), /outside CoNest's supported range/);
});

test('numeric OpenClaw repacks use their base release at each host API boundary', () => {
  for (const [repack, base] of [
    ['2026.7.1-1', '2026.7.1'],
    ['2026.8.1-1', '2026.8.1'],
    ['2026.9.2-1', '2026.9.2'],
    ['2026.9.5-1', '2026.9.5'],
  ]) {
    assert.equal(openClawApiVersion(repack), base);
    assert.equal(openClawContractForVersion(repack), openClawContractForVersion(base));
    assert.equal(usesLegacyAgentList(repack), usesLegacyAgentList(base));
    assert.equal(supportsGatewayRuntimePatch(repack), supportsGatewayRuntimePatch(base));
  }
  assert.equal(usesLegacyAgentList('2026.8.1-1'), false);
  assert.equal(openClawContractForVersion('2026.9.2-1'), 'scoped-v2');
  assert.equal(supportsGatewayRuntimePatch('2026.9.5-1'), true);
});


test('runtime host selection scopes filesystem overrides and restores authored pins after installer failure', async t => {
  const f = await fixture(t);
  const script = path.join(f.root, 'scripts/maintenance/select-openclaw-version.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await cp(new URL('../scripts/maintenance/select-openclaw-version.mjs', import.meta.url), script);
  const require = createRequire(import.meta.url);
  await cp(path.dirname(require.resolve('semver/package.json')), path.join(f.root, 'node_modules/semver'), { recursive: true });
  await cp(new URL('../compatibility.json', import.meta.url), path.join(f.root, 'compatibility.json'));
  const originals = new Map([
    ['package.json', '{"name":"isolated-runtime-fixture","private":true}\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
    ['pnpm-workspace.yaml', 'packages: []\n\noverrides:\n  "existing-package": "1.0.0"\n'],
  ]);
  for (const [name, content] of originals) await writeFile(path.join(f.root, name), content);
  const installer = path.join(f.root, 'fake-installer.cjs');
  await writeFile(installer, `const fs = require('node:fs');
fs.writeFileSync('installer-observation.json', JSON.stringify({
  args: process.argv.slice(2), workspace: fs.readFileSync('pnpm-workspace.yaml', 'utf8')
}));
fs.writeFileSync('package.json', '{"changedByInstaller":true}');
process.exit(23);
`);
  const bin = path.join(f.root, 'bin');
  await mkdir(bin);
  const windows = process.platform === 'win32';
  await writeFile(path.join(bin, windows ? 'pnpm.cmd' : 'pnpm'), windows
    ? '@echo off\r\nnode "%CONEST_TEST_INSTALLER%" %*\r\n'
    : '#!/bin/sh\nexec node "$CONEST_TEST_INSTALLER" "$@"\n', { mode: 0o700 });
  const cases = [
    ['2026.9.36', false],
    ['2026.10.1', true],
    ['2026.10.5', true],
    ['2026.10.5-1', true],
    ['2026.10.6', true],
    ['2026.10.7', true],
    ['2026.10.8', true],
    ['2026.10.9', true],
    ['2026.10.9-1', true],
    ['2026.10.10', false],
    ['2026.10.10-1', false],
  ] as const;
  for (const [version, overridden] of cases) await t.test(version, async () => {
    await assert.rejects(promisify(execFile)(process.execPath, [script, version], {
      cwd: f.root,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CONEST_TEST_INSTALLER: installer },
    }), /Command failed/);
    const observed = JSON.parse(await readFile(path.join(f.root, 'installer-observation.json'), 'utf8'));
    assert.ok(observed.args.includes(`openclaw@${version}`));
    assert.ok(observed.args.includes(`@openclaw/deepseek-provider@${version.replace(/-\d+$/, '')}`));
    const pin = `"openclaw@${version}>@openclaw/fs-safe": "0.26.10"`;
    assert.equal(observed.workspace.includes(pin), overridden, version);
    assert.equal([...observed.workspace.matchAll(/openclaw@[^"\n]+>@openclaw\/fs-safe/g)].length, overridden ? 1 : 0);
    assert.match(observed.workspace, /"existing-package": "1\.0\.0"/);
    for (const [name, content] of originals) assert.equal(await readFile(path.join(f.root, name), 'utf8'), content, `${version}: ${name}`);
  });
});

test('handles prerelease DSH versions with an explicit adapter range', () => {
  assert.equal(inspectCompatibility('DSH', DSH_TESTED_VERSION, DSH_COMPATIBILITY_RANGE, [DSH_TESTED_VERSION]).tested, true);
  assert.equal(inspectDsh('0.1.0-rc.7').tested, true);
  assert.equal(inspectDsh('0.1.0-rc.8').tested, true);
  assert.equal(inspectDsh('0.1.6-alpha.2').tested, true);
  assert.equal(inspectDsh('0.2.1-rc.2').tested, true);
  assert.equal(inspectCompatibility('Cordis', '4.0.5', CORDIS_COMPATIBILITY_RANGE, ['4.0.5']).tested, true);
  assert.throws(() => inspectDsh('0.1.5-rc.2'), /outside/);
  assert.throws(() => inspectCompatibility('DSH', '0.2.0', DSH_COMPATIBILITY_RANGE, []), /outside/);
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

test('keeps published compatibility metadata aligned with package discovery metadata', async () => {
  const compatibility = JSON.parse(await readFile('compatibility.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(compatibility.adapters.openclaw.supported, OPENCLAW_COMPATIBILITY_RANGE);
  assert.equal(pkg.peerDependencies.openclaw, OPENCLAW_COMPATIBILITY_RANGE);
  assert.equal(pkg.openclaw.compat.pluginApi, OPENCLAW_COMPATIBILITY_RANGE);
  assert.equal(pkg.openclaw.compat.minGatewayVersion, `${compatibility.adapters.openclaw.minimum}-0`);
  assert.equal(compatibility.adapters.dsh.supported, DSH_COMPATIBILITY_RANGE);
  assert.equal(compatibility.adapters.dsh.cordis, CORDIS_COMPATIBILITY_RANGE);
  assert.deepEqual(compatibility.adapters.openclaw.tested, [...OPENCLAW_TESTED_VERSIONS]);
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
      else if (!file.split(path.sep).join('/').startsWith('src/adapters/') && /\.(?:[cm]?ts|[cm]?js)$/.test(file)) {
        const source = await readFile(file, 'utf8');
        if (/\bfrom\s+["'](?:openclaw\/|@deepseek-ai\/)|\bimport\s*\(["'](?:openclaw\/|@deepseek-ai\/)/.test(source)) violations.push(file);
      }
    }
  }
  assert.deepEqual(violations, []);
});

import { hasToolRestrictionsForAllow } from '../src/adapters/openclaw-harness.js';

test('legacy developer-instruction builder reports restrictions only for concrete allowlists', () => {
  assert.equal(hasToolRestrictionsForAllow(undefined), false);
  assert.equal(hasToolRestrictionsForAllow(['*']), false);
  assert.equal(hasToolRestrictionsForAllow(['  *  ']), false);
  assert.equal(hasToolRestrictionsForAllow(['*', 'read']), false);
  assert.equal(hasToolRestrictionsForAllow(['read']), true);
  assert.equal(hasToolRestrictionsForAllow(['read', 'bash']), true);
  assert.equal(hasToolRestrictionsForAllow([' bash ']), true);
});

test('native tools preserve call identity, errors, policy denial and drained cancellation', async t => {
  const ctx = new Context();
  const prompt = await settleFiber(ctx.plugin(SystemPrompt));
  const tools = await settleFiber(ctx.plugin(ToolRuntime, { mode: 'native' }));
  t.after(async () => { await tools.dispose(); await prompt.dispose(); });
  let calls = 0;
  ctx.tools.register({
    name: 'echo', description: 'Adapter regression fixture', parameters: { type: 'object' },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      calls++;
      assert.equal(String(execution.callId), 'adapter-call');
      return args;
    },
  });
  const input = { callId: ToolCallId('adapter-call'), name: 'echo',
    arguments: { text: 'quoted "text"\n中文', nested: [true, null, 42] }, signal: new AbortController().signal };
  const result = await executeTool(ctx.tools, input);
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, input.arguments);
  assert.equal(result.content[0]?.type, 'text');
  const missing = await executeTool(ctx.tools, { ...input, name: 'missing' });
  assert.equal(missing.isError, true);
  const release = ctx.tools.guard(() => 'denied by fixture policy');
  const denied = await executeTool(ctx.tools, input);
  assert.equal(denied.isError, true);
  assert.equal(calls, 1, 'Denied calls must not reach the tool body');
  release();

  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let settled = false;
  ctx.tools.register({ name: 'wait', description: 'Cancellation fixture', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    async execute(_args, execution) {
      ready();
      try {
        await new Promise<void>(resolve => execution.signal.addEventListener('abort', () => resolve(), { once: true }));
        execution.signal.throwIfAborted();
        return null;
      } finally { settled = true; }
    },
  });
  const controller = new AbortController();
  const pending = executeTool(ctx.tools, { ...input, name: 'wait', signal: controller.signal });
  await started;
  controller.abort(new Error('cancel adapter fixture'));
  await pending.then(value => assert.equal(value.isError, true), error => assert.match(String(error), /cancel|abort/i));
  assert.equal(settled, true, 'Cancellation must drain the submitted tool body');

  if (typeof Reflect.get(ctx.tools, 'setExecutor') === 'function') {
    for (const results of [[], [{ callId: 'another-call', result }]]) {
      Reflect.set(ctx.tools, 'execute', async () => ({ results }));
      await assert.rejects(executeTool(ctx.tools, input), /did not return the requested call/);
    }
  }
});
