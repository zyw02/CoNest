import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BridgeRuntime } from '../../../dist/runtime.js';
import { BridgeClient } from '../../../dist/client.js';
import { resolveConfig } from '../../../dist/config.js';
import { capabilities, observations } from './profile.mjs';

let sequence = 0;
const principal = { kind: 'agent', agentId: 'main' };
const request = (workspaceRoot, capability, args = {}, permissions = ['workspace:read']) => ({
  workspaceRoot, capability, args, permissions, principal, subject: 'qualification', taskId: `task-${++sequence}`, callId: `call-${sequence}`,
});
const invoke = async (runtime, workspace, capability, args, permissions) => {
  const input = request(workspace, capability, args, permissions);
  return (await runtime.invoke({ ...input, authorization: runtime.authorize(input).token })).value;
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conest-dsh-compat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const component = path.join(directory, 'component');
  await mkdir(path.join(workspace, 'skills', 'compat-skill'), { recursive: true });
  await mkdir(component);
  await writeFile(path.join(workspace, 'source.txt'), 'alpha marker\nsecond line\nthird line\nfourth line\n');
  await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 255, 0, 255]));
  await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(8192) + '\nlast\n');
  await writeFile(path.join(directory, 'outside.txt'), 'outside secret');
  await symlink(path.join(directory, 'outside.txt'), path.join(workspace, 'escape.txt'));
  await writeFile(path.join(workspace, 'skills', 'compat-skill', 'SKILL.md'), '---\nname: compat-skill\ndescription: Controlled compatibility fixture\n---\nRead-only fixture body.\n');
  const manifest = path.join(component, 'component.json');
  await writeFile(path.join(component, 'index.mjs'), `export { name, inject, apply } from ${JSON.stringify(new URL('./profile.mjs', import.meta.url).href)};\n`);
  await writeFile(manifest, JSON.stringify({ id: 'dsh-qualification', version: '0.1.0', description: 'Developer-only real DSH qualification', entry: './index.mjs', requires: {}, capabilities }));
  const config = { workspaceRoot: workspace, components: [{ manifest, config: { workspaceRoot: workspace } }], startupTimeoutMs: 5000 };
  return { workspace, manifest, config, directory };
}

test('real DSH filesystem, read tool, skills and search run through CoNest', async t => {
  const { workspace, config } = await fixture(t);
  const runtime = await BridgeRuntime.create(resolveConfig(config), () => {});
  try {
    assert.equal(runtime.status().state, 'ready', JSON.stringify(runtime.status()));
    await t.test('local provider reads bytes, stats, bounds directory output and rejects oversized files', async () => {
      assert.match((await invoke(runtime, workspace, 'compat_fs', { op: 'read', path: 'source.txt' })).text, /alpha marker/);
      assert.equal((await invoke(runtime, workspace, 'compat_fs', { op: 'stat', path: 'source.txt' })).info.type, 'file');
      assert.equal((await invoke(runtime, workspace, 'compat_fs', { op: 'stat', path: 'missing.txt' })).info, null);
      const listing = await invoke(runtime, workspace, 'compat_fs', { op: 'list', path: '.' });
      assert.equal(listing.entries.length, 3); assert.equal(listing.truncated, true);
      await assert.rejects(invoke(runtime, workspace, 'compat_fs', { op: 'read', path: 'large.txt' }), /limit|large|bytes/i);
    });
    await t.test('real read tool streams line windows, caps long lines, rejects missing and binary files', async () => {
      const value = await invoke(runtime, workspace, 'compat_read', { path: 'source.txt', offset: 2, limit: 2 });
      assert.deepEqual(value.lines, [{ number: 2, text: 'second line' }, { number: 3, text: 'third line' }]);
      const large = await invoke(runtime, workspace, 'compat_read', { path: 'large.txt' });
      assert.ok(large.lines[0].text.length < 100);
      await assert.rejects(invoke(runtime, workspace, 'compat_read', { path: 'missing.txt' }), /not found|does not exist/i);
      await assert.rejects(invoke(runtime, workspace, 'compat_read', { path: 'binary.bin' }), /text|UTF|binary/i);
      await assert.rejects(invoke(runtime, workspace, 'compat_read', { path: 'source.txt', limit: 4 }), { code: 'INVALID_ARGUMENTS' });
    });
    await t.test('wrapper rejects traversal and symlink escape; host permission and exact capability allowlist apply', async () => {
      for (const capability of ['compat_fs', 'compat_read']) for (const file of ['../outside.txt', 'escape.txt']) {
        await assert.rejects(invoke(runtime, workspace, capability, { path: file, ...(capability === 'compat_fs' ? { op: 'read' } : {}) }), { code: 'PATH_OUTSIDE_WORKSPACE' });
      }
      await assert.rejects(invoke(runtime, workspace, 'compat_read', { path: 'source.txt' }, []), { code: 'PERMISSION_DENIED' });
      const names = runtime.catalog({ principal, permissions: ['workspace:read'] }).capabilities.map(item => item.name);
      for (const name of ['write', 'edit', 'read_image', 'todo_write', 'exit_plan_mode', 'skill']) assert.ok(!names.includes(name));
      assert.ok(observations.get(workspace).tools.get('write'), 'native suite is mounted but mutation is not bridged');
      assert.equal(observations.get(workspace).tools.get('read_image'), undefined);
      assert.equal(await readFile(path.join(workspace, 'source.txt'), 'utf8'), 'alpha marker\nsecond line\nthird line\nfourth line\n');
    });
    await t.test('native glob and baseline grep run real subprocesses without a DSH agent', async () => {
      assert.match(JSON.stringify(await invoke(runtime, workspace, 'compat_glob')), /source\.txt/);
      assert.ok((await invoke(runtime, workspace, 'knowledge_search', { query: 'alpha marker' })).totalMatches > 0);
    });
    await t.test('real Skill registry and filesystem provider list/get only controlled roots', async () => {
      const listing = await invoke(runtime, workspace, 'compat_skills');
      assert.deepEqual(listing.skills.map(item => item.name), ['compat-skill']);
      assert.match((await invoke(runtime, workspace, 'compat_skills', { name: 'compat-skill' })).skill.content, /Read-only fixture body/);
      assert.equal((await invoke(runtime, workspace, 'compat_skills', { name: 'missing' })).skill, null);
    });
    await t.test('actual Todo and Plan reject missing sessions; actual tool-skill stays unregistered without agents', async () => {
      const value = await invoke(runtime, workspace, 'compat_host_requirements');
      assert.equal(value.todo_write.activated, true); assert.match(value.todo_write.error, /owning agent session/);
      assert.equal(value.exit_plan_mode.activated, true); assert.match(value.exit_plan_mode.error, /requires a calling agent/);
      assert.deepEqual(value.skill.missing, ['agents']); assert.equal(value.skill.registered, false);
      console.log('COMPAT_EVIDENCE ' + JSON.stringify({ hostRequirements: value }));
    });
    await t.test('native filesystem pre-abort and mid-stream cancellation are observed', async () => {
      const { fs } = observations.get(workspace);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(fs.resolve('source.txt', { signal: controller.signal }), /aborted/i);
      // A large real stream guarantees another chunk remains after the first one.
      await writeFile(path.join(workspace, 'stream.bin'), 'a'.repeat(512 * 1024));
      const active = new AbortController();
      const stream = (await fs.streamText(await fs.resolve('stream.bin'), active.signal))[Symbol.asyncIterator]();
      assert.equal((await stream.next()).done, false);
      active.abort();
      await assert.rejects(stream.next(), /abort/i);
      await stream.return?.();
    });
    await t.test('native effects dispose on disable, remove tools/providers, then reactivate on enable', async () => {
      const old = observations.get(workspace);
      await runtime.reload(resolveConfig({ ...config, components: [{ ...config.components[0], enabled: false }] }));
      assert.equal(old.tools.get('read'), undefined);
      assert.equal(old.tools.get('todo_write'), undefined);
      assert.equal(old.tools.get('exit_plan_mode'), undefined);
      assert.equal(old.tools.get('glob'), undefined);
      assert.deepEqual(await old.skills.list({ cwd: workspace }), []);
      assert.ok(!runtime.catalog({ principal, permissions: ['workspace:read'] }).capabilities.some(item => item.name === 'compat_read'));
      await runtime.reload(resolveConfig(config));
      assert.notEqual(observations.get(workspace).tools, old.tools);
      assert.match(JSON.stringify(await invoke(runtime, workspace, 'compat_read', { path: 'source.txt' })), /alpha marker/);
    });
  } finally { await runtime.close(); observations.delete(workspace); }
});

test('real DSH read and host-requirement diagnostics cross the production worker RPC', async t => {
  const { workspace, directory, config } = await fixture(t);
  const configFile = path.join(directory, 'bridge.json');
  await writeFile(configFile, JSON.stringify(config));
  const client = new BridgeClient({ workerFile: fileURLToPath(new URL('../../../dist/worker.js', import.meta.url)), configFile,
    workspaceRoot: workspace, startupTimeoutMs: 10000, shutdownTimeoutMs: 5000, onLog: (_level, message) => console.error(message) });
  try {
    assert.equal((await client.start()).state, 'ready');
    assert.match(JSON.stringify((await client.invoke(request(workspace, 'compat_read', { path: 'source.txt' }))).value), /alpha marker/);
    assert.match(JSON.stringify((await client.invoke(request(workspace, 'compat_host_requirements'))).value), /owning agent session/);
  } finally { await client.stop(); }
});
