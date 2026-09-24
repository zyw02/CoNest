import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeReview, renderReview } from '../scripts/review-policy.mjs';

const review = async (files, sources = {}, patches = new Map()) => analyzeReview({
  files,
  patches,
  readFile: async file => sources[file] ?? '',
});

test('blocks third-party SDK imports outside adapter boundaries', async () => {
  const report = await review(['src/runtime.ts'], { 'src/runtime.ts': "import x from 'openclaw/plugin-sdk/core';\n" });
  assert.equal(report.decision, 'changes-requested');
  assert(report.findings.some(item => item.id === 'adapter-bypass'));
});

test('requires focused evidence when an adapter contract changes', async () => {
  const missing = await review(['src/adapters/openclaw-sdk.ts']);
  assert(missing.findings.some(item => item.id === 'compatibility-evidence'));
  const covered = await review(['src/adapters/openclaw-sdk.ts', 'test/compatibility.test.ts']);
  assert(!covered.findings.some(item => item.id === 'compatibility-evidence'));
});

test('renders stable bot marker and a human-review decision', async () => {
  const report = await review(['README.md']);
  assert.equal(report.decision, 'ready-for-human-review');
  assert.match(renderReview(report), /conest-review:v1/);
});
