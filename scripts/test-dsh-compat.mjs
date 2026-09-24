import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packagePaths, sourceRoot } from '../test/experiments/dsh-compat/profile.mjs';
import { executionEnvironment } from '../dist/environment.js';
import { reportDirectory } from './report-path.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.CONEST_REPORT_PROFILE ? path.join(reportDirectory, 'dsh-compatibility') : path.join(root, '.local/reports', 'dsh-compatibility');
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function treeHash(directory) {
  const hash = createHash('sha256');
  async function visit(base, prefix = '') {
    for (const entry of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name, full = path.join(base, entry.name);
      if (entry.isDirectory()) await visit(full, relative + '/');
      else if (entry.isFile()) hash.update(relative + '\0' + await sha256(full) + '\n');
      else throw new Error(`Unexpected non-regular provenance file: ${full}`);
    }
  }
  await visit(directory); return hash.digest('hex');
}
async function provenance() {
  return Promise.all(Object.entries(packagePaths).map(async ([profileKey, relative]) => {
    const directory = fileURLToPath(new URL(`packages/${relative}/`, sourceRoot));
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    return { profileKey, name: pkg.name, version: pkg.version, source: `packages/${relative}`,
      manifestSha256: await sha256(path.join(directory, 'package.json')),
      sourceTreeSha256: await treeHash(path.join(directory, 'src')), builtTreeSha256: await treeHash(path.join(directory, 'lib')) };
  }));
}
const packages = await provenance();
const tracked = ['test/experiments/dsh-compat/profile.mjs', 'test/experiments/dsh-compat/compat.test.mjs', 'scripts/test-dsh-compat.mjs',
  'dist/runtime.js', 'dist/loader-runtime.js', 'dist/components.js', 'dist/client.js', 'dist/worker.js', 'pnpm-lock.yaml'];
const hashes = Object.fromEntries(await Promise.all(tracked.map(async file => [file, await sha256(path.join(root, file))])));
await mkdir(output, { recursive: true });
try {
  const result = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=30000',
    'test/experiments/dsh-compat/compat.test.mjs'], { cwd: root, env: executionEnvironment(), timeout: 45000, maxBuffer: 4000000 });
  const metric = name => Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
  for (const name of ['fail', 'cancelled', 'skipped']) assert.equal(metric(name), 0);
  assert.ok(metric('tests') >= 10); assert.equal(metric('pass'), metric('tests'));
  const evidence = JSON.parse(result.stdout.match(/^# COMPAT_EVIDENCE (.+)$/m)?.[1] ?? 'null');
  assert.ok(evidence?.hostRequirements);
  assert.deepEqual(await provenance(), packages, 'DSH source/build changed during qualification');
  for (const [file, hash] of Object.entries(hashes)) assert.equal(await sha256(path.join(root, file)), hash);
  const report = { recordedAt: new Date().toISOString(), bridgeVersion: JSON.parse(await readFile(path.join(root, 'package.json'))).version,
    platform: process.platform, arch: process.arch, node: process.version, tests: metric('tests'), passed: metric('pass'), failed: 0,
    paidModelCalls: 0, externalNetworkCalls: 0, workerRpc: true, packages, hashes, evidence,
    results: { local: 'qualified-read-only-profile', read: 'qualified-read-tool-only', search: 'qualified-glob-and-baseline-grep',
      skills: 'qualified-registry-list-get', skillFiles: 'qualified-explicit-roots-watch-disabled',
      skillTool: 'blocked-activation-agents-missing', todo: 'activated-but-invocation-requires-session', plan: 'activated-but-invocation-requires-agent',
      web: 'static-review-only-network-out-of-scope', webTool: 'static-review-only-network-out-of-scope' },
    limits: ['Developer checkout profile, not shipped/default tools or a relocatable package', 'Linux only; selected package source/build hashes are not full transitive closure hashes',
      'No DSH Agent/Session or synthetic substitutes; no additional agent loop', 'No mutation, attachments, web, watcher, model-injection or adversarial filesystem-race qualification',
      'Filesystem cancellation probes are provider-level, not new end-to-end cancellation qualification'] };
  await writeFile(path.join(output, 'result.tap'), result.stdout);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ recordedAt: new Date().toISOString(), hashes, packages,
    error: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2) + '\n');
  process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}\n`); throw error;
}
