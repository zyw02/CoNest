import assert from 'node:assert/strict';
import { mkdir, open, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BridgeClient } from '../src/client.js';
import { CordisBridgeHost } from '../src/studio/cordis-bridge-host.js';
import type { ManagedReadResult } from '../src/read-contract.js';
import { fixture, request, hasCode, eventually } from './helpers.js';

async function worker(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await writeFile(f.configFile, JSON.stringify({ workspaceRoot: f.workspace }));
  const client = new BridgeClient({ workerFile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)), configFile: f.configFile, startupTimeoutMs: 15000, shutdownTimeoutMs: 5000 });
  await client.start(); t.after(() => client.stop());
  const read = async (args: Record<string, unknown>) => (await client.invoke(request(f.workspace, 'dsh_read', args))).value as ManagedReadResult;
  return { ...f, client, read };
}

test('managed read preserves DSH windows, validation, truncation and UTF-8 errors', async t => {
  const f = await worker(t);
  await writeFile(path.join(f.workspace, 'source.txt'), '第一行\r\nsecond\r\nthird\r\n');
  const result = await f.read({ file_path: 'source.txt', offset: 2, limit: 1 });
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, { path: path.join(f.workspace, 'source.txt'), offset: 2, lines: [{ number: 2, text: 'second' }], totalLines: 3 });
  assert.match(result.content[0].text, /2: second/);
  assert.equal(result.observation?.observation.kind, 'present');
  const pastEnd = await f.read({ file_path: path.join(f.workspace, 'source.txt'), offset: 99 });
  assert.equal(pastEnd.isError, true); assert.match(pastEnd.error!.message, /offset|range|lines/i);
  for (const args of [{ offset: 0 }, { offset: 1.5 }, { limit: 2001 }]) assert.equal((await f.read({ file_path: 'source.txt', ...args })).isError, true);
  await assert.rejects(f.read({}), hasCode('INVALID_ARGUMENTS'));
  const absent = await f.read({ file_path: 'missing.txt' });
  assert.equal(absent.isError, true); assert.equal(absent.observation?.observation.kind, 'absent');
  await mkdir(path.join(f.workspace, 'directory'));
  assert.equal((await f.read({ file_path: 'directory' })).isError, true);
  await writeFile(path.join(f.workspace, 'binary'), Buffer.from([0, 0xff]));
  const binary = await f.read({ file_path: 'binary' }); assert.equal(binary.isError, true); assert.equal(binary.observation, undefined);
  await writeFile(path.join(f.workspace, 'large.txt'), Array.from({ length: 2100 }, () => 'x'.repeat(2500)).join('\n'));
  const large = await f.read({ file_path: 'large.txt' });
  assert.equal(large.isError, false); assert.ok(Buffer.byteLength(large.content[0].text) < 60000);
  assert.match(large.content[0].text, /truncat|limit|continue/i);
});

test('read component enforces path and permission boundaries and restores without restarting search', async t => {
  const f = await worker(t);
  await writeFile(path.join(f.workspace, 'source.txt'), 'read marker');
  await writeFile(path.join(f.root, 'outside.txt'), 'outside');
  if (process.platform !== 'win32') await symlink(f.root, path.join(f.workspace, 'escape'), 'dir');
  for (const file_path of ['../outside.txt', f.root, ...(process.platform !== 'win32' ? ['escape/outside.txt'] : [])]) await assert.rejects(f.read({ file_path }), hasCode('PERMISSION_DENIED'));
  await assert.rejects(f.client.invoke({ ...request(f.workspace, 'dsh_read', { file_path: 'source.txt' }), permissions: [] }), hasCode('PERMISSION_DENIED'));
  const denied = { ...request(f.workspace, 'dsh_read', { file_path: 'source.txt' }), capabilityCeiling: { deny: ['dsh_read'] } };
  assert.ok(!(await f.client.catalog(denied)).capabilities.some(c => c.name === 'dsh_read'));
  await assert.rejects(f.client.invoke(denied), hasCode('CAPABILITY_DENIED'));
  const pid = (await f.client.status()).pid;
  await f.client.manage({ action: 'disable', id: 'dsh-read' });
  await assert.rejects(f.read({ file_path: 'source.txt' }), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.ok((await f.client.invoke(request(f.workspace, 'knowledge_search', { query: 'read marker' }))).value);
  await f.client.manage({ action: 'enable', id: 'dsh-read' });
  assert.equal((await f.read({ file_path: 'source.txt' })).isError, false);
  assert.equal((await f.client.status()).pid, pid);
});

test('worker read observations preserve guarded Gateway edits, session isolation, absence and stale-version rejection', async t => {
  const f = await worker(t);
  const host = new CordisBridgeHost();
  await host.start({ workspaceRoot: f.workspace });
  t.after(() => host.stop());
  const file = path.join(f.workspace, 'source.txt');
  await writeFile(file, 'before');
  const edit = (owner: string, old_string = 'before') => host.execute('edit', 'edit', { file_path: 'source.txt', old_string, new_string: 'after' }, owner);
  assert.equal((await host.execute('read', 'read', { file_path: 'source.txt' }, 'owner')).isError, true, 'No local read fallback');
  assert.equal((await edit('owner')).isError, true, 'Unread edit must remain denied');
  const read = await f.read({ file_path: 'source.txt' }); assert.ok(read.observation);
  const signal = new AbortController().signal;
  await host.observeRead(read.observation, 'owner', signal);
  assert.equal((await edit('other')).isError, true, 'Read authority cannot cross owners');
  assert.equal((await edit('owner')).isError, false);
  assert.equal(await readFile(file, 'utf8'), 'after');
  const prior = await f.read({ file_path: 'source.txt' }); assert.ok(prior.observation);
  await writeFile(file, 'externally changed');
  await host.observeRead(prior.observation, 'owner', signal);
  assert.equal((await edit('owner', 'externally changed')).isError, true, 'Handoff cannot adopt an unread newer version');
  assert.equal(await readFile(file, 'utf8'), 'externally changed');
  const current = await f.read({ file_path: 'source.txt' }); assert.ok(current.observation);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(host.observeRead(current.observation, 'cancelled', cancelled.signal));
  assert.equal((await edit('cancelled', 'externally changed')).isError, true);
  await rm(file);
  const missing = await f.read({ file_path: 'source.txt' }); assert.ok(missing.observation);
  await host.observeRead(missing.observation, 'owner', signal);
  assert.equal((await host.execute('create', 'write', { file_path: 'source.txt', content: 'created' }, 'owner')).isError, false);
  assert.equal(await readFile(file, 'utf8'), 'created');
});

test('cancelling and revoking a real streaming read closes its file descriptor and task', { skip: process.platform !== 'linux' }, async t => {
  const f = await worker(t);
  const file = path.join(f.workspace, 'stream.txt');
  const fd = await open(file, 'w');
  try { const block = Buffer.from('x\n'.repeat(512 * 1024)); for (let i = 0; i < 256; i++) await fd.write(block); } finally { await fd.close(); }
  const pid = (await f.client.status()).pid;
  async function reading() {
    const descriptors = await readdir(`/proc/${pid}/fd`);
    return (await Promise.all(descriptors.map(d => readlink(`/proc/${pid}/fd/${d}`).catch(() => '')))).includes(file);
  }
  for (const reason of ['cancel', 'policy']) {
    const controller = new AbortController();
    const pending = f.client.invoke({ ...request(f.workspace, 'dsh_read', { file_path: file }), signal: controller.signal });
    const failed = assert.rejects(pending, /cancel|abort|policy changed/i);
    await eventually(reading, 10000);
    if (reason === 'cancel') controller.abort(new Error('host cancelled read'));
    else await f.client.manage({ action: 'policy', policy: { agents: { main: { deny: ['dsh_read'] } } } });
    await failed;
    await eventually(async () => !await reading() && (await f.client.status()).tasks === 0, 5000);
    assert.equal((await f.client.status()).pid, pid);
  }
});
