import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { reportDirectory, reportPath } from './report-path.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
const npmCli = path.join(source, 'node_modules/npm/bin/npm-cli.js');
const live = process.argv.includes('--live');
const hostEnhancements = process.argv.includes('--host-enhancements');
assert.ok(!(live && hostEnhancements), 'Host enhancement qualification is an offline-model profile');
const archiveArg = process.argv.find(value => value.endsWith('.tgz'));
assert.ok(archiveArg, 'Usage: test-installation.mjs ARCHIVE.tgz [--live | --host-enhancements]');
const archive = path.resolve(archiveArg);
const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex');
assert.equal((await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0], archiveHash, 'Archive checksum mismatch');
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-install-'));
const installation = path.join(root, 'installation');
const workspace = path.join(root, 'workspace');
const state = path.join(root, 'profile');
const installed = path.join(installation, 'node_modules/@local/conest-connector');
const localCli = path.join(installed, 'dist/local-cli.js');
const bridgeCli = path.join(installed, 'dist/cli.js');
const marker = `install-${randomUUID()}`;
const quote = `${marker} belongs to the clean installation fixture.`;
const env = { ...process.env, NO_COLOR: '1' };
for (const name of Object.keys(env)) if (/^(OPENCLAW_|DEEPSEEK_|OPENAI_|ANTHROPIC_|NODE_PATH$|NODE_OPTIONS$)/.test(name)) delete env[name];
const records = [];
let profileCreated = false;
const run = async (file, args, timeout = 120_000) => {
  const result = await execute(process.execPath, [file, ...args], { cwd: workspace, env, timeout, maxBuffer: 8_000_000 });
  return JSON.parse(result.stdout);
};
const local = (command, ...args) => run(localCli, [command, '--state', state, ...args]);
const bridge = (...args) => run(bridgeCli, ['--config', path.join(state, 'bridge.json'), '--json', ...args]);
const step = message => process.stderr.write(`${message}\n`);
async function filesIn(directory, base = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, base), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Installed runtime members must not link outside their package');
    const file = path.join(base, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(directory, file));
    else files.push(file);
  }
  return files.sort();
}

try {
  await mkdir(installation);
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'evidence.txt'), `${quote}\n`);
  step('Installing the CoNest Connector archive offline, without host peers or lifecycle scripts');
  await execute(process.execPath, [npmCli, 'install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', archive],
    { cwd: installation, env, timeout: 120_000, maxBuffer: 4_000_000 });
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@local/conest-connector');
  for (const [canonical, legacy] of [['conest', 'dsh-bridge'], ['conest-local', 'dsh-bridge-local']]) {
    const results = await Promise.all([canonical, legacy].map(name => execute(process.execPath,
      [path.join(installation, 'node_modules/.bin', name), '--help'], { cwd: workspace, env, timeout: 10_000 })));
    assert.equal(results[0].stdout, results[1].stdout);
    assert.ok(results[0].stdout.startsWith(`Usage: ${canonical} `));
  }
  records.push({ check: 'installed CoNest CLI names and legacy aliases resolve to the same executable behavior', passed: true });
  const lock = JSON.parse(await readFile(path.join(installed, 'runtime-lock.json'), 'utf8'));
  assert.ok(Object.values(manifest.dependencies).every(value => !/^(link|workspace|file):/.test(value)));
  for (const dependency of lock.dependencies) {
    const canonical = await realpath(path.join(installed, 'node_modules', dependency.location ?? dependency.name));
    assert.ok(canonical.startsWith(`${installation}${path.sep}`), `${dependency.name} escaped the clean installation`);
    const files = (await filesIn(canonical)).filter(file => !file.split(path.sep).includes('node_modules'));
    assert.equal(files.length, dependency.files, `Installed file count differs for ${dependency.name}`);
    const hash = createHash('sha256');
    for (const file of files) hash.update(file).update('\0').update(await readFile(path.join(canonical, file))).update('\0');
    assert.equal(hash.digest('hex'), dependency.sha256, `Installed content differs for ${dependency.name}`);
  }
  const standaloneConfig = path.join(root, 'standalone.json');
  await run(bridgeCli, ['init', '--config', standaloneConfig, '--workspace', workspace]);
  const search = await run(bridgeCli, ['--config', standaloneConfig, '--json', 'search', marker]);
  assert.equal(search.value.totalMatches, 1);
  records.push({ check: 'offline archive-only real DSH search, with no source checkout or host package', passed: true });

  step('Installing the pinned official host and DeepSeek provider from the public registry');
  await execute(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
    'openclaw@2026.9.2', '@openclaw/deepseek-provider@2026.9.2'],
  { cwd: installation, env, timeout: 300_000, maxBuffer: 4_000_000 });
  const credentialFile = live ? (process.env.CONEST_CREDENTIAL_FILE ?? process.env.BRIDGE_CREDENTIAL_FILE ?? '/root/.config/dsh-bridge/deepseek.env') : path.join(root, 'fake.env');
  if (!live) await writeFile(credentialFile, 'DEEPSEEK_API_KEY=test-only-not-a-real-key\n', { mode: 0o600 });
  const setup = await run(localCli, ['setup', '--state', state, '--workspace', workspace, '--credentials', credentialFile]);
  profileCreated = true;
  const doctor = await local('doctor', ...live ? ['--probe'] : []);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.hostVersion, '2026.9.2');
  records.push({ check: 'installed CLI setup and official host configuration validation', passed: true });

  step('Starting the owned local service and checking live component management');
  const started = await local('start');
  assert.equal(started.state, 'ready');
  const duplicate = await local('start');
  assert.equal(duplicate.supervisorPid, started.supervisorPid, 'An idempotent start must not create a second supervisor');
  const before = await bridge('status');
  const verifier = path.join(installed, 'examples/source-verifier/component.json');
  const installedComponent = await bridge('components', 'install', verifier);
  assert.equal(installedComponent.pid, before.pid);
  const verified = await bridge('invoke', 'source_verify', JSON.stringify({ query: marker, quote }));
  assert.equal(verified.value.verified, true);
  const workerEnvironment = await readFile(`/proc/${before.pid}/environ`, 'utf8');
  for (const name of ['DEEPSEEK_API_KEY=', 'OPENCLAW_GATEWAY_TOKEN=', 'NODE_OPTIONS=']) {
    assert.equal(workerEnvironment.includes(name), false, 'The worker inherited a sensitive parent setting');
  }
  records.push({ check: 'same-worker component install/invoke and credential-free worker environment', passed: true });

  let successfulTask;
  let deniedTask;
  if (live) {
    step('Running one direct, streamed DeepSeek Flash task through the installed Gateway');
    successfulTask = await local('ask', '--message', `Use read to read evidence.txt, knowledge_search for ${marker}, bridge_capabilities to discover the installed source_verify schema and generation, and bridge_invoke to verify the exact source quote. Consume the real verification result before returning DELIVERED: followed by the exact source sentence and filename.`);
    assert.equal(successfulTask.status, 'ok');
    const meta = successfulTask.result.meta;
    assert.equal(meta.agentMeta.provider, 'deepseek');
    assert.equal(meta.agentMeta.model, 'deepseek-v4-flash');
    assert.equal(meta.agentMeta.agentHarnessId, 'openclaw');
    assert.equal(meta.executionTrace.fallbackUsed, false);
    assert.ok(JSON.stringify(successfulTask.result.payloads).includes(quote));
    for (const tool of ['read', 'knowledge_search', 'bridge_capabilities', 'bridge_invoke']) {
      assert.ok(meta.agentMeta.terminalReceipt.successfulToolNames.includes(tool), `Missing successful direct-model tool: ${tool}`);
    }
    records.push({ check: 'direct official DeepSeek provider, real main Loop, and source-backed CLI delivery', passed: true });
  }

  step('Stopping, preserving the installed component, and restarting the service');
  assert.equal((await local('stop')).state, 'stopped');
  assert.equal((await local('status')).state, 'stopped');
  assert.equal((await local('stop')).state, 'stopped');
  const hostFile = path.join(state, 'openclaw.json');
  const host = JSON.parse(await readFile(hostFile, 'utf8'));
  host.agents.entries.restricted = { workspace, tools: { deny: ['knowledge_search'] } };
  await writeFile(hostFile, `${JSON.stringify(host, null, 2)}\n`);
  // Readiness is independent of a particular capability's policy or dependency state.
  await bridge('components', 'disable', 'dsh-search');
  const policyFile = path.join(root, 'restricted-policy.json');
  await writeFile(policyFile, JSON.stringify({ agents: { main: { allow: [] } } }));
  await bridge('policy', 'set', policyFile);
  const restarted = await local('start');
  assert.equal(restarted.state, 'ready');
  assert.equal(restarted.bridgeState, 'degraded');
  assert.notEqual(restarted.supervisorPid, started.supervisorPid);
  await bridge('components', 'enable', 'dsh-search');
  await writeFile(policyFile, '{}');
  await bridge('policy', 'set', policyFile);
  assert.equal((await local('status')).bridgeState, 'ready');
  assert.ok((await bridge('catalog')).capabilities.some(item => item.name === 'source_verify'));
  records.push({ check: 'owned stop/start, idempotent stop, persisted components, and restart with an empty policy-filtered catalog and blocked dependency', passed: true });

  if (live) {
    step('Checking a real dependent permission denial with no bypass or retry');
    const beforeDenial = await bridge('status');
    deniedTask = await local('ask', '--agent', 'restricted', '--message',
      `Perform one controlled authorization check in this synthetic workspace. Discover bridge_capabilities, then invoke source_verify exactly once through bridge_invoke with query ${marker} and quote ${JSON.stringify(quote)}, using its current generation. If the worker denies permission, stop and return POLICY_PROBE_BLOCKED with a brief explanation. Do not retry, bypass the denial, or claim verification succeeded.`);
    assert.ok(JSON.stringify(deniedTask.result.payloads).includes('POLICY_PROBE_BLOCKED'));
    assert.equal((await bridge('status')).policyDenials, beforeDenial.policyDenials + 1);
    assert.equal(deniedTask.result.meta.agentMeta.agentHarnessId, 'openclaw');
    assert.equal(deniedTask.result.meta.toolSummary.failures, 1);
    records.push({ check: 'real model observes one nested worker denial and stops', passed: true });
  }

  step('Terminating the owned Gateway to verify failure visibility and explicit recovery');
  process.kill(restarted.gatewayPid, 'SIGKILL');
  for (let i = 0; i < 150; i++) {
    if ((await local('status')).state === 'stopped') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await local('status')).state, 'stopped');
  assert.equal((await local('start')).state, 'ready');
  assert.equal((await bridge('invoke', 'source_verify', JSON.stringify({ query: marker, quote }))).value.verified, true);
  records.push({ check: 'Gateway failure does not auto-replay work; explicit start recovers persisted components', passed: true });
  assert.equal((await local('stop')).state, 'stopped');
  const savedConfig = await readFile(hostFile, 'utf8');
  assert.ok(savedConfig.includes('${DEEPSEEK_API_KEY}'), 'The credential reference must remain symbolic on disk');
  let archiveGatewayFlow;
  if (hostEnhancements) {
    step('Qualifying context, session reset and diagnostics using only the installed Connector and host');
    const result = await execute(process.execPath, [path.join(source, 'scripts/test-e2e.mjs'), '--context-provider', '--capability-guidance'], {
      cwd: workspace, env: { ...env, CONEST_TEST_PLUGIN_ROOT: installed, CONEST_REPORT_PROFILE: `conest-${manifest.version}-archive` },
      timeout: 180_000, maxBuffer: 8_000_000,
    });
    archiveGatewayFlow = JSON.parse(result.stdout);
    assert.equal(archiveGatewayFlow.artifactTesting, true);
    assert.equal(archiveGatewayFlow.bridgeVersion, manifest.version);
    assert.equal(archiveGatewayFlow.contextSessionReset, true);
    assert.equal(archiveGatewayFlow.contextDiagnosticsShared, true);
    for (const [field, file] of [['adapterSha256', 'index.js'], ['hostAdapterSha256', 'host-adapter.js'], ['contextProviderSha256', 'context-provider.js']]) {
      assert.equal(archiveGatewayFlow[field], createHash('sha256').update(await readFile(path.join(installed, 'dist', file))).digest('hex'));
    }
    records.push({ check: 'archive-installed host context, native session reset and shared private diagnostics in the actual Gateway', passed: true });
  }
  const report = { recordedAt: new Date().toISOString(), bridgeVersion: manifest.version, archive: path.basename(archive), archiveSha256: archiveHash,
    bundledPackages: lock.dependencies.length, platform: { node: process.version, os: process.platform, arch: process.arch },
    cleanDirectoryOutsideCheckout: true, directProvider: live, hostEnhancements, archiveGatewayFlow, setup, checks: records,
    successfulTask, deniedTask, finalState: 'stopped', credentialsCopied: false, channelsConnected: false };
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath(live ? 'installation-live.json' : 'installation.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, successfulTask: undefined, deniedTask: undefined }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}\n`);
  process.exitCode = 1;
} finally {
  if (profileCreated) {
    try { await local('stop'); }
    catch { /* A failed startup may have no reachable owner; preserve the private directory if still occupied. */ }
    const status = await local('status').catch(() => undefined);
    if (!status || status.state !== 'stopped') {
      process.stderr.write(`Preserved test directory because supervisor shutdown was not confirmed: ${root}\n`);
      process.exitCode = 1;
    } else await rm(root, { recursive: true, force: true });
  } else await rm(root, { recursive: true, force: true });
}
