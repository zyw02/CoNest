import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readComponent, resolveConfig } from '../src/config.js';

test('configuration pins the builtin dependency flow and rejects unknown fields', async context => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-config-'));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const config = resolveConfig({ workspaceRoot: workspace });
  assert.deepEqual(config.components.map(component => component.manifest.id), ['dsh-memory', 'dsh-read', 'dsh-search', 'result-verifier']);
  assert.equal(config.maxConcurrent, 4);
  assert.throws(() => resolveConfig({ workspaceRoot: workspace, surprise: true }), /Unknown configuration field/);
});

test('external component entries cannot escape their component directory', async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-manifest-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const component = path.join(root, 'component');
  await mkdir(component);
  const outside = path.join(root, 'outside.js');
  await writeFile(outside, 'export default {}\n');
  const manifest = path.join(component, 'component.json');
  await writeFile(manifest, JSON.stringify({
    id: 'escape-attempt', version: '1.0.0', description: 'fixture', entry: '../outside.js',
    requires: {}, capabilities: [],
  }));
  assert.throws(() => readComponent(manifest), /must stay inside/);
});
