import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageVersion, reportDirectory, reportPath } from './report-path.mjs';

// Local candidate verification is deliberately separate from paid-provider release equivalence.
const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: verify-candidate.mjs ARCHIVE.tgz');
const archive = path.resolve(process.argv[2]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = async file => digest(await readFile(file));
const archiveSha256 = await sha256(archive);
assert.equal((await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0], archiveSha256);
const reportFiles = {
  installation: reportPath('installation.json'), runtime: reportPath('runtime.json'), inspection: reportPath('openclaw-inspection.json'),
  gateway: reportPath('e2e.json'), compatibility: reportPath('dsh-compatibility/result.json'),
  defaultGateway: path.join(root, '.local/reports', `conest-${packageVersion}-default/e2e.json`),
  archiveGateway: path.join(root, '.local/reports', `conest-${packageVersion}-archive/e2e.json`),
};
const evidence = {};
for (const [name, file] of Object.entries(reportFiles)) {
  const bytes = await readFile(file);
  const report = JSON.parse(bytes);
  assert.equal(report.bridgeVersion, packageVersion, `${name} must qualify the current version`);
  evidence[name] = { report, sha256: digest(bytes), file: path.relative(root, file) };
}
const installation = evidence.installation.report;
assert.equal(installation.archiveSha256, archiveSha256);
assert.equal(installation.cleanDirectoryOutsideCheckout, true);
assert.equal(installation.directProvider, false);
assert.equal(installation.hostEnhancements, true);
assert.equal(installation.finalState, 'stopped');
assert.ok(installation.checks.length >= 7 && installation.checks.every(check => check.passed === true));
assert.equal(evidence.inspection.report.status, 'loaded');
assert.deepEqual(evidence.inspection.report.diagnostics, []);
for (const name of ['runtime', 'compatibility']) {
  const report = evidence[name].report;
  assert.ok(report.tests > 0);
  assert.equal(report.passed, report.tests);
  assert.equal(report.failed, 0);
  assert.equal(report.paidModelCalls, 0);
}
for (const name of ['gateway', 'archiveGateway']) {
  const report = evidence[name].report;
  assert.equal(report.gatewayMainLoop, true);
  assert.equal(report.dynamicContext, true);
  assert.equal(report.contextSessionReset, true);
  assert.equal(report.contextDiagnosticsShared, true);
  assert.ok(report.contextChecks.length >= 8);
  assert.ok(report.contextChecks.every(check => check.modelToolCalls === 0 && check.modelRequests === 1));
}
assert.equal(evidence.archiveGateway.report.artifactTesting, true);
assert.equal(evidence.defaultGateway.report.dynamicContext, false);
assert.equal(evidence.defaultGateway.report.capabilityGuidance, false);

// Compare every executable Connector module with the actual archive, not just its entry point.
const runtimeFiles = (await readdir(path.join(root, 'dist'))).filter(file => file.endsWith('.js')).sort();
const runtimeHashes = {};
for (const file of runtimeFiles) {
  const member = `package/dist/${file}`;
  const archived = await execute('tar', ['-xOzf', archive, member], { encoding: 'buffer', maxBuffer: 4_000_000 });
  const hash = await sha256(path.join(root, 'dist', file));
  assert.equal(digest(archived.stdout), hash, `${member} does not match the current emitted code`);
  runtimeHashes[file] = hash;
}
assert.ok(runtimeFiles.length >= 25);
for (const name of ['gateway', 'archiveGateway']) {
  const report = evidence[name].report;
  assert.equal(report.adapterSha256, runtimeHashes['index.js']);
  assert.equal(report.hostAdapterSha256, runtimeHashes['host-adapter.js']);
  assert.equal(report.contextProviderSha256, runtimeHashes['context-provider.js']);
}
assert.equal(installation.archiveGatewayFlow.adapterSha256, runtimeHashes['index.js']);

const tests = (await readdir(path.join(root, 'test'))).filter(file => file.endsWith('.test.ts')).sort().map(file => `test/${file}`);
const suite = await execute(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-reporter=tap', ...tests],
  { cwd: root, timeout: 60_000, maxBuffer: 8_000_000 });
const metric = name => Number(suite.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
assert.ok(metric('tests') >= 77);
assert.equal(metric('pass'), metric('tests'));
for (const name of ['fail', 'cancelled', 'skipped']) assert.equal(metric(name), 0);
for (const [file, hash] of Object.entries(runtimeHashes)) assert.equal(await sha256(path.join(root, 'dist', file)), hash);
for (const item of Object.values(evidence)) assert.equal(await sha256(path.join(root, item.file)), item.sha256, 'Evidence changed during verification');
assert.equal(await sha256(archive), archiveSha256);
const report = {
  recordedAt: new Date().toISOString(), bridgeVersion: packageVersion, qualification: 'local-private-candidate',
  archive: path.relative(root, archive), archiveSha256, bundledPackages: installation.bundledPackages,
  tests: { suite: metric('tests'), suitePassed: metric('pass'), runtime: evidence.runtime.report.tests, compatibility: evidence.compatibility.report.tests },
  evidence: Object.fromEntries(Object.entries(evidence).map(([name, item]) => [name, { file: item.file, sha256: item.sha256 }])),
  runtimeHashes, exactArchiveInstalled: true, allChecksPassed: true, paidModelCalls: 0, published: false, productionDeployed: false,
  limits: ['OpenClaw 2026.9.2 on Linux x64 only', 'Local model fixture, not model-quality qualification',
    'No new session/history API or public marketplace', 'Trusted components, not hostile-code sandboxing'],
};
await mkdir(reportDirectory, { recursive: true });
await writeFile(reportPath('suite.tap'), suite.stdout);
await writeFile(reportPath('candidate.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
