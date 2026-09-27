import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { reportDirectory, reportPath } from './report-path.mjs';

const require = createRequire(import.meta.url);
const version = require(path.resolve(path.dirname(require.resolve('openclaw/plugin-sdk/plugin-entry')), '../../package.json')).version;
const expected = process.env.CONEST_EXPECT_OPENCLAW_VERSION;
assert.ok(expected, 'Set CONEST_EXPECT_OPENCLAW_VERSION to the matrix member');
assert.equal(version, expected, 'The tests must execute the selected host, not the build SDK');
const stages = [
  ['adapter behavior', ['--import', 'tsx', '--test', 'test/compatibility.test.ts', 'test/host-adapter.test.ts',
    'test/dsh-harness.test.ts', 'test/platform.test.ts', 'test/local.test.ts', 'test/openclaw-adapter.test.ts']],
  ['real plugin activation', ['scripts/test-openclaw.mjs']],
  ['Gateway and Studio execution', ['scripts/demo-studio.mjs', '--verify']],
];
const report = { version, platform: process.platform, node: process.version, stages: [], passed: true };
await mkdir(reportDirectory, { recursive: true });
const state = await mkdtemp(path.join(tmpdir(), 'conest-matrix-studio-'));
const listener = createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
try {
  for (const [name, args] of stages) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, CONEST_DEMO_STATE: state, CONEST_DEMO_PORT: String(port) }, maxBuffer: 8 * 1024 * 1024 });
    const passed = !result.error && result.status === 0;
    report.stages.push({ name, passed, status: result.status, error: result.error?.message });
    await writeFile(reportPath(`${name.replaceAll(' ', '-')}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    process.stdout.write(`${version}: ${name}: ${passed ? 'passed' : 'FAILED'}\n`);
    if (!passed) { report.passed = false; process.stderr.write(`${result.stdout ?? ''}\n${result.stderr ?? ''}`); }
  }
} finally {
  await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
await writeFile(reportPath('matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
