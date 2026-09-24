import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageVersion, reportDirectory, reportPath } from './report-path.mjs';
import { executionEnvironment } from '../dist/environment.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const files = ['src/components.ts', 'src/loader-runtime.ts', 'src/runtime.ts', 'src/types.ts',
  'dist/components.js', 'dist/loader-runtime.js', 'dist/runtime.js', 'dist/types.js',
  'lib/src/components.js', 'lib/src/loader-runtime.js', 'lib/src/runtime.js', 'lib/src/types.js',
  'test/loader-runtime.test.ts', 'lib/test/loader-runtime.test.js', 'scripts/test-runtime.mjs', 'pnpm-lock.yaml'];
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, await sha256(path.join(root, file))])));
for (const name of ['components', 'loader-runtime', 'runtime', 'types']) assert.equal(hashes[`lib/src/${name}.js`], hashes[`dist/${name}.js`]);
const provenance = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-loader'].map(async name => ({
  name, version: JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version,
  entrySha256: await sha256(require.resolve(name)),
})));
let result;
try {
  // No TypeScript runtime or model fixture: exercise the actual emitted graph implementation.
  result = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=20000',
    'lib/test/loader-runtime.test.js'], { cwd: root, env: executionEnvironment(), timeout: 30_000, maxBuffer: 4_000_000 });
} catch (error) {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath('runtime-failure.json'), JSON.stringify({ recordedAt: new Date().toISOString(),
    bridgeVersion: packageVersion, hashes, error: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2));
  process.stderr.write(`${error.stdout ?? ''}${error.stderr ?? ''}\n`);
  throw error;
}
const metric = name => Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm'))?.[1]);
assert.ok(metric('tests') >= 18);
for (const name of ['fail', 'cancelled', 'skipped']) assert.equal(metric(name), 0);
assert.equal(metric('pass'), metric('tests'));
for (const [file, hash] of Object.entries(hashes)) assert.equal(await sha256(path.join(root, file)), hash, 'Source changed during runtime verification');
const report = { recordedAt: new Date().toISOString(), bridgeVersion: packageVersion,
  node: process.version, builtJavaScript: true, tests: metric('tests'), passed: metric('pass'), failed: metric('fail'),
  hashes, provenance, paidModelCalls: 0,
  limits: ['Trusted application fixtures; not arbitrary DSH compatibility', 'No market or additional host implemented',
    'No rollback guarantee for module globals, root context access, or external side effects'] };
await mkdir(reportDirectory, { recursive: true });
await writeFile(reportPath('runtime.tap'), result.stdout);
await writeFile(reportPath('runtime.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
