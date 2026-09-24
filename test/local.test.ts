import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executionEnvironment } from '../src/environment.js';
import { readLocal, setupLocal, statusLocal, stopLocal, validateLocalBoundary } from '../src/local.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-local-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const credentials = path.join(root, 'deepseek.env');
  const state = path.join(root, 'profile');
  await mkdir(workspace);
  await writeFile(credentials, 'DEEPSEEK_API_KEY=test-only-not-a-real-key\n', { mode: 0o600 });
  return { root, workspace, credentials, state };
}

test('local setup creates a private direct-provider profile without copying credentials or overwriting state', async t => {
  const f = await fixture(t);
  const profile = await setupLocal(f.state, f);
  const loaded = await readLocal(f.state);
  assert.equal(loaded.settings.workspaceRoot, f.workspace);
  assert.equal(loaded.settings.port, profile.settings.port);
  const host = JSON.parse(await readFile(profile.gatewayFile, 'utf8'));
  assert.equal(host.models.providers.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(host.models.providers.deepseek.apiKey, '${DEEPSEEK_API_KEY}');
  assert.equal(host.models.providers.deepseek.agentRuntime.id, 'openclaw');
  assert.equal(host.agents.defaults.model.primary, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(host.agents.defaults.model.fallbacks, []);
  assert.equal(host.plugins.entries['dsh-bridge'].hooks.allowConversationAccess, true);
  assert.ok(!JSON.stringify(host).includes('test-only-not-a-real-key'));
  const original = await readFile(profile.file, 'utf8');
  await assert.rejects(setupLocal(f.state, f), { code: 'EEXIST' });
  assert.equal(await readFile(profile.file, 'utf8'), original);
  assert.equal((await statusLocal(loaded)).state, 'stopped');
  assert.equal((await stopLocal(loaded)).state, 'stopped');
});

test('local setup rejects searchable credentials, overlapping state, symlinks, and unsafe file permissions', async t => {
  const f = await fixture(t);
  await chmod(f.credentials, 0o644);
  await assert.rejects(setupLocal(f.state, f), { code: 'LOCAL_FILE_UNSAFE' });
  await chmod(f.credentials, 0o600);
  const linked = path.join(f.root, 'linked.env');
  await symlink(f.credentials, linked);
  await assert.rejects(setupLocal(f.state, { ...f, credentials: linked }), { code: 'LOCAL_FILE_UNSAFE' });
  await assert.rejects(setupLocal(path.join(f.workspace, 'profile'), f), { code: 'LOCAL_LAYOUT_UNSAFE' });
  const inside = path.join(f.workspace, 'credentials.env');
  await writeFile(inside, 'DEEPSEEK_API_KEY=test-only-not-a-real-key\n', { mode: 0o600 });
  await assert.rejects(setupLocal(f.state, { ...f, credentials: inside }), { code: 'LOCAL_LAYOUT_UNSAFE' });
  await assert.rejects(setupLocal(f.state, { ...f, port: 22 }), { code: 'PORT_INVALID' });
});

test('local configuration parsing fails closed on changed layout and unknown fields', async t => {
  const f = await fixture(t);
  const profile = await setupLocal(f.state, f);
  await writeFile(profile.file, JSON.stringify({ ...profile.settings, unknown: true }));
  await assert.rejects(readLocal(f.state), { code: 'LOCAL_CONFIG_INVALID' });
  await writeFile(profile.file, JSON.stringify(profile.settings));
  await chmod(f.state, 0o755);
  await assert.rejects(readLocal(f.state), { code: 'LOCAL_DIRECTORY_UNSAFE' });
  await chmod(f.state, 0o700);
  await chmod(profile.gatewayFile, 0o644);
  await assert.rejects(readLocal(f.state), { code: 'LOCAL_FILE_UNSAFE' });
});

test('component environments retain OS execution settings but exclude provider secrets and loader overrides', () => {
  const env = executionEnvironment({ PATH: '/usr/bin', HOME: '/safe/home', LC_ALL: 'C',
    DEEPSEEK_API_KEY: 'private', OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private',
    OPENCLAW_GATEWAY_TOKEN: 'private', NODE_OPTIONS: '--require unsafe-loader', NODE_PATH: '/outside', CUSTOM_SECRET: 'private' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/safe/home', LC_ALL: 'C' });
});

test('local credentials cannot be routed by edited host configuration and stop remains available', async t => {
  const f = await fixture(t);
  const profile = await setupLocal(f.state, f);
  await validateLocalBoundary(profile);
  const host = JSON.parse(await readFile(profile.gatewayFile, 'utf8'));
  host.models.providers.deepseek.baseUrl = 'https://invalid.example';
  await writeFile(profile.gatewayFile, JSON.stringify(host));
  await assert.rejects(validateLocalBoundary(profile), { code: 'LOCAL_BOUNDARY_CHANGED' });
  assert.equal((await stopLocal(await readLocal(f.state))).state, 'stopped');
  host.models.providers.deepseek.baseUrl = 'https://api.deepseek.com';
  await writeFile(profile.gatewayFile, JSON.stringify(host));
  const bridge = JSON.parse(await readFile(profile.bridgeFile, 'utf8'));
  bridge.workspaceRoot = f.root;
  await writeFile(profile.bridgeFile, JSON.stringify(bridge));
  await assert.rejects(validateLocalBoundary(profile), { code: 'LOCAL_BOUNDARY_CHANGED' });
});
