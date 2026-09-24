import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
