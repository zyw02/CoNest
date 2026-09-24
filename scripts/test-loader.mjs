import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const output = path.join(root, '.local/reports/loader-feasibility');
const provenance = [];
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader']) {
  const entry = require.resolve(name);
  const manifest = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
  provenance.push({ name, version: manifest.version, entrySha256: createHash('sha256').update(await readFile(entry)).digest('hex') });
}
assert.equal(provenance[0].version, '4.0.1');
assert.equal(provenance[1].version, '1.0.2');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'].includes(key)));
let result;
try {
  result = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=20000',
    'test/experiments/loader/loader.test.mjs'], { cwd: root, env, timeout: 30_000, maxBuffer: 4_000_000 });
} catch (error) {
  process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}\n`);
  throw error;
}
const metric = name => Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
assert.ok(metric('tests') >= 10);
assert.equal(metric('fail'), 0);
assert.equal(metric('cancelled'), 0);
assert.equal(metric('skipped'), 0);
assert.equal(metric('pass'), metric('tests'));
const testSources = {};
for (const file of ['test/experiments/loader/fixture.mjs', 'test/experiments/loader/loader.test.mjs', 'scripts/test-loader.mjs']) {
  testSources[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
const report = { recordedAt: new Date().toISOString(), purpose: 'Native Loader feasibility, not production integration',
  testSources,
  node: process.version, provenance, tests: metric('tests'), passed: metric('pass'), failed: metric('fail'),
  productionRuntimeChanged: false, paidModelCalls: 0,
  conclusions: { unchangedInstancesPreserved: true, nativeReplacementDrainsApplicationCalls: false,
    nativeFailedActivationPreservesOldInstance: false, isolatedRevisionCoexistence: true,
    isolatedCandidateFailurePreservesAcceptedInstances: true, asyncRemovalAwaited: true,
    settlementDoesNotImplyReadiness: true, duplicateIdsRejectedBeforeMutation: true,
    settledRemovalDoesNotProveCleanupSuccess: true },
  limits: ['Test plugins, not arbitrary DSH plugins', 'Retirement is explicitly sequenced by tests; production graph leases are not implemented',
    'No OpenClaw runtime switch or Agent Plugins installer implemented by this experiment'] };
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'test.tap'), result.stdout);
await writeFile(path.join(output, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
