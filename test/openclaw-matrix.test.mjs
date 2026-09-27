import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOpenClawMatrix } from '../scripts/maintenance/openclaw-matrix.mjs';

test('covers every stable release and numeric repack, including intermediate maintenance releases', () => {
  const versions = ['2026.9.6', '2026.9.1', '2026.6.1', '2026.7.1-beta.6', '2026.7.1-2',
    '2026.7.1', '2026.7.1-1', '2026.7.35', '2026.8.1', '2026.8.1', '2026.10.1-beta.1'];
  const selected = ['2026.7.1', '2026.7.1-1', '2026.7.1-2', '2026.7.35', '2026.8.1', '2026.9.1', '2026.9.6'];
  for (const entries of [versions, Object.fromEntries(versions.map(v => [v, {}]))]) {
    assert.deepEqual(resolveOpenClawMatrix({ versions: entries, 'dist-tags': { latest: '2026.9.6' } }, '2026.7.1'), selected);
  }
});

test('new stable releases automatically join the matrix without losing earlier releases', () => {
  const versions = ['2026.7.1', '2026.9.6', '2026.10.1'];
  assert.deepEqual(resolveOpenClawMatrix({ versions, 'dist-tags': { latest: '2026.10.1' } }, '2026.7.1'), versions);
});

test('missing release metadata fails rather than silently shrinking coverage', () => {
  for (const metadata of [{}, { versions: ['2026.7.1'], 'dist-tags': { latest: '2026.9.6' } },
    { versions: ['2026.9.6'], 'dist-tags': { latest: '2026.9.6' } },
    { versions: ['2026.7.1'], 'dist-tags': { latest: '2026.9.6-beta.1' } }]) {
    assert.throws(() => resolveOpenClawMatrix(metadata, '2026.7.1'));
  }
});
