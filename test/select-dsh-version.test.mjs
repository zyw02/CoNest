import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDshPackages, selectDshWorkspace } from '../scripts/maintenance/select-dsh-version.mjs';

const revision = 'ddefc45fbc7f8e46dd73185e68295696d1297887';

test('replaces frozen DSH paths with exact packages from one upstream revision', async () => {
  const input = {
    dependencies: {
      '@deepseek-ai/dsh-tools': 'file:.vendor/dsh/packages/core/tools',
      '@deepseek-ai/cordis': 'file:.vendor/dsh/vendor/cordis',
      '@deepseek-ai/dsh-unused': 'file:.vendor/dsh/packages/unused',
      semver: '7.8.5',
    },
    devDependencies: {
      '@deepseek-ai/dsh-agent': 'file:.vendor/dsh/packages/core/agent',
    },
  };
  const packages = {
    'vendor/cordis': { name: '@deepseek-ai/cordis', version: '4.0.2' },
  };
  const required = new Set(['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent']);
  const result = await selectDshPackages(input, '0.1.6-alpha.2', revision, async relative => packages[relative], required);
  assert.equal(result.manifest.dependencies['@deepseek-ai/dsh-tools'], '0.1.6-alpha.2');
  assert.equal(result.manifest.dependencies['@deepseek-ai/cordis'], '4.0.2');
  assert.equal(result.manifest.devDependencies['@deepseek-ai/dsh-agent'], '0.1.6-alpha.2');
  assert.equal(result.manifest.dependencies.semver, '7.8.5');
  assert.equal(result.manifest.dependencies['@deepseek-ai/dsh-unused'], undefined);
  assert.equal(input.dependencies['@deepseek-ai/dsh-tools'], 'file:.vendor/dsh/packages/core/tools');
  assert.equal(result.selected.length, 3);
});

test('removes frozen overrides and enables peer installation for public packages', () => {
  const source = `packages: []

autoInstallPeers: false

overrides:
  "@deepseek-ai/dsh-agent": "file:.vendor/dsh/packages/core/agent"

patchedDependencies:
  "node-pty@1.1.0": patches/node-pty@1.1.0.patch

allowBuilds:
  "@deepseek-ai/dsh-subprocess-local@file:.vendor/dsh/packages/subprocess/subprocess-local": true
`;
  const selected = selectDshWorkspace(source, { '@earendil-works/pi-ai': '0.85.1' });
  assert.match(selected, /autoInstallPeers: true/);
  assert.doesNotMatch(selected, /file:\.vendor\/dsh/);
  assert.match(selected, /overrides:\n  "@earendil-works\/pi-ai": "0\.85\.1"/);
  assert.match(selected, /"@deepseek-ai\/dsh-subprocess-local": true/);
  assert.match(selected, /patchedDependencies:/);
});

test('rejects empty package selections and mutable revisions', async () => {
  const input = { devDependencies: { '@deepseek-ai/dsh-agent': 'file:.vendor/dsh/packages/core/agent' } };
  await assert.rejects(
    selectDshPackages(input, '0.1.6-alpha.2', revision, async () => ({}), new Set()),
    /No DSH adapter packages/,
  );
  await assert.rejects(
    selectDshPackages(input, '0.1.6-alpha.2', 'dsh-v0.1.6-alpha.2', async () => ({}), new Set()),
    /full commit SHA/,
  );
});
