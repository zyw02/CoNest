import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BridgeClient } from '../src/client.js';
import { configuredHostCeiling } from '../src/host-policy.js';
import { fixture, request, hasCode, eventually } from './helpers.js';

async function worker(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await writeFile(f.configFile, JSON.stringify({ workspaceRoot: f.workspace }));
  const client = new BridgeClient({ workerFile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)), configFile: f.configFile, startupTimeoutMs: 15000, shutdownTimeoutMs: 5000 });
  await client.start();
  t.after(() => client.stop());
  return { ...f, client, call: (name: string, args: Record<string, unknown>) => client.invoke(request(f.workspace, name, args)) };
}
const value = (r: { value: unknown }) => r.value as { content: Array<{ type: string; text: string }>; value: { matches: Array<{ path: string; lineNumber: number; line: string }>; paths: string[] }; totalMatches: number; truncated: boolean; matches: unknown[] };

test('worker preserves literal, regex, glob and native preview semantics with workspace-relative paths', async t => {
  const f = await worker(t);
  await mkdir(path.join(f.workspace, 'nested'));
  await writeFile(path.join(f.workspace, 'nested/source.ts'), 'alpha.literal\nalphaXliteral\nsecond\n');
  await writeFile(path.join(f.workspace, 'nested/other.txt'), 'alpha.literal\n');
  const catalog = await f.client.catalog({ principal: { kind: 'agent', agentId: 'main' }, permissions: ['workspace:read'] });
  for (const name of ['knowledge_search', 'dsh_grep', 'dsh_glob']) assert.equal(catalog.capabilities.find(c => c.name === name)?.provider.id, 'dsh-search');
  assert.equal(value(await f.call('knowledge_search', { query: 'alpha.literal' })).totalMatches, 2);
  const grep = value(await f.call('dsh_grep', { pattern: 'alpha.literal', path: 'nested', include: '*.ts' }));
  assert.deepEqual(grep.value.matches, [
    { path: 'nested/source.ts', lineNumber: 1, line: 'alpha.literal' },
    { path: 'nested/source.ts', lineNumber: 2, line: 'alphaXliteral' },
  ]);
  assert.match(grep.content[0].text, /Line 2: alphaXliteral/);
  assert.deepEqual(value(await f.call('dsh_grep', { pattern: 'not-present' })).value.matches, []);
  assert.deepEqual(value(await f.call('dsh_glob', { pattern: '**/*.ts' })).value.paths, ['nested/source.ts']);
  assert.deepEqual(value(await f.call('dsh_glob', { pattern: '*.ts', path: path.join(f.workspace, 'nested') })).value.paths, ['nested/source.ts']);
  await assert.rejects(f.call('dsh_grep', { pattern: '[' }), /pattern rejected|regex parse/i);
  await assert.rejects(f.call('dsh_grep', {}), hasCode('INVALID_ARGUMENTS'));
  await assert.rejects(f.call('dsh_glob', { pattern: '*' , path: '' }), hasCode('INVALID_ARGUMENTS'));
  await writeFile(path.join(f.workspace, 'many.txt'), Array.from({ length: 260 }, (_, i) => `cap-marker ${i}`).join('\n'));
  const capped = value(await f.call('dsh_grep', { pattern: 'cap-marker', path: 'many.txt' }));
  assert.equal(capped.value.matches.length, 260);
  assert.match(capped.content[0].text, /Found 250 of 260/);
  assert.match(capped.content[0].text, /could not be saved/);
  const literal = value(await f.call('knowledge_search', { query: 'cap-marker' }));
  assert.equal(literal.totalMatches, 260); assert.equal(literal.matches.length, 100); assert.equal(literal.truncated, true);
  await writeFile(path.join(f.workspace, 'oversize.txt'), 'large-marker ' + 'x'.repeat(2_100_000));
  await assert.rejects(f.call('dsh_grep', { pattern: 'large-marker', path: 'oversize.txt' }), hasCode('RESULT_TOO_LARGE'));
  assert.deepEqual(value(await f.call('dsh_glob', { pattern: 'oversize.txt' })).value.paths, ['oversize.txt']);
  assert.equal((await f.client.status()).tasks, 0);
});

test('managed search enforces workspace paths, per-entry host ceilings, live policy and component disable/re-enable', async t => {
  const f = await worker(t);
  await writeFile(path.join(f.workspace, 'source.txt'), 'search marker\n');
  await writeFile(path.join(f.root, 'outside.txt'), 'private marker\n');
  await symlink(f.root, path.join(f.workspace, 'escape'), 'dir');
  for (const name of ['dsh_grep', 'dsh_glob']) {
    for (const target of ['..', path.join(f.root, 'outside.txt'), 'escape/outside.txt']) await assert.rejects(f.call(name, { pattern: 'marker', path: target }), hasCode('PERMISSION_DENIED'));
    await assert.rejects(f.client.invoke({ ...request(f.workspace, name, { pattern: 'marker' }), permissions: [] }), hasCode('PERMISSION_DENIED'));
    const capabilityCeiling = configuredHostCeiling({ tools: { deny: [name] } }, 'main');
    const catalog = await f.client.catalog({ principal: { kind: 'agent', agentId: 'main' }, permissions: ['workspace:read'], capabilityCeiling });
    assert.ok(!catalog.capabilities.some(c => c.name === name));
    await assert.rejects(f.client.invoke({ ...request(f.workspace, name, { pattern: 'marker' }), capabilityCeiling, expectedGeneration: catalog.generation }), hasCode('CAPABILITY_DENIED'));
  }
  await f.client.manage({ action: 'policy', policy: { agents: { main: { deny: ['dsh_grep'] } } } });
  await assert.rejects(f.call('dsh_grep', { pattern: 'marker' }), hasCode('CAPABILITY_DENIED'));
  assert.equal(value(await f.call('knowledge_search', { query: 'marker' })).totalMatches, 1);
  await f.client.manage({ action: 'policy', policy: {} });
  const pid = (await f.client.status()).pid;
  await f.client.manage({ action: 'disable', id: 'dsh-search' });
  for (const name of ['knowledge_search', 'dsh_grep', 'dsh_glob']) await assert.rejects(f.call(name, name === 'knowledge_search' ? { query: 'marker' } : { pattern: 'marker' }), hasCode('CAPABILITY_UNAVAILABLE'));
  await f.client.manage({ action: 'enable', id: 'dsh-search' });
  assert.equal(value(await f.call('dsh_grep', { pattern: 'marker' })).value.matches.length, 1);
  assert.equal(value(await f.call('dsh_glob', { pattern: '*.txt' })).value.paths.length, 1);
  assert.equal((await f.client.status()).pid, pid);
});

test('real ripgrep cancellation and active policy revocation release the worker task and child process', { skip: process.platform !== 'linux' }, async t => {
  const f = await worker(t);
  // Explicit FIFO input makes real packaged ripgrep wait; no fake search handler.
  const fifo = path.join(f.workspace, 'waiting.fifo');
  await promisify(execFile)('mkfifo', [fifo]);
  const pid = (await f.client.status()).pid;
  const children = async () => (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
  for (const reason of ['cancel', 'policy']) {
    const controller = new AbortController();
    const pending = f.client.invoke({ ...request(f.workspace, 'dsh_grep', { pattern: 'wait', path: fifo }), signal: controller.signal });
    const rejected = assert.rejects(pending, /cancel|abort|denied|revok|policy changed/i);
    await eventually(async () => !!await children(), 5000);
    if (reason === 'cancel') controller.abort(new Error('host cancelled search'));
    else await f.client.manage({ action: 'policy', policy: { agents: { main: { deny: ['dsh_grep'] } } } });
    await rejected;
    await eventually(async () => (await f.client.status()).tasks === 0 && !await children(), 5000);
    assert.equal((await f.client.status()).pid, pid);
  }
});
