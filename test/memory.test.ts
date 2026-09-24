import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BridgeClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { createMemoryAccess } from '../src/memory-adapter.js';
import { ALL_PERMISSIONS, type Principal, type Permission } from '../src/types.js';
import { resolveAutomaticMemorySubject } from '../src/studio/automatic-memory.js';
import { fixture, request, hasCode } from './helpers.js';

async function worker(t: Parameters<typeof fixture>[0], initial?: string) {
  const f = await fixture(t);
  const file = path.join(f.root, 'memory.jsonl');
  if (initial !== undefined) await writeFile(file, initial);
  // Studio binding is deliberately absent from disk; management must preserve it.
  await writeFile(f.configFile, JSON.stringify({ workspaceRoot: f.workspace }));
  const options = { workerFile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)), configFile: f.configFile, memoryFilePath: file, startupTimeoutMs: 15000, shutdownTimeoutMs: 5000 };
  const client = new BridgeClient(options);
  const status = await client.start(); t.after(() => client.stop());
  const call = async (capability: string, args: Record<string, unknown> = {}, principal: Principal = { kind: 'agent', agentId: 'main' }, permissions: Permission[] = [...ALL_PERMISSIONS]) =>
    (await client.invoke({ ...request(f.workspace, capability, args), principal, permissions })).value as any;
  const native = (name: string, args: Record<string, unknown> = {}) => call(`dsh_mcp__reference_memory__${name}`, args);
  return { ...f, client, call, native, file, options, status };
}

test('memory preserves legacy JSONL and all nine native graph tool contracts', async t => {
  const f = await worker(t, JSON.stringify({ type: 'entity', name: 'legacy', entityType: 'person', observations: ['old preference'] }) + '\n');
  assert.equal(f.status.components.find(c => c.id === 'dsh-memory')?.state, 'ready');
  assert.equal(f.status.capabilities.filter(c => c.provider.id === 'dsh-memory').length, 11);
  assert.match(JSON.stringify(await f.native('read_graph')), /old preference/);
  await f.native('create_entities', { entities: [{ name: 'new', entityType: 'person', observations: ['new preference'] }] });
  await f.native('create_relations', { relations: [{ from: 'legacy', to: 'new', relationType: 'knows' }] });
  await f.native('add_observations', { observations: [{ entityName: 'legacy', contents: ['added'] }] });
  const found = await f.native('search_nodes', { query: 'added' });
  assert.equal(found.value.structuredContent.entities[0].name, 'legacy');
  assert.equal(found.value.structuredContent.relations.length, 1);
  assert.ok(found.content[0].text.includes('added'));
  assert.match(JSON.stringify(await f.native('open_nodes', { names: ['new'] })), /new preference/);
  await f.native('delete_observations', { deletions: [{ entityName: 'legacy', observations: ['added'] }] });
  await f.native('delete_relations', { relations: [{ from: 'legacy', to: 'new', relationType: 'knows' }] });
  await f.native('delete_entities', { entityNames: ['new'] });
  const graph = (await f.native('read_graph')).value.structuredContent;
  assert.deepEqual(graph, { entities: [{ name: 'legacy', entityType: 'person', observations: ['old preference'] }], relations: [] });
  await f.client.stop(); await f.client.start();
  assert.deepEqual((await f.native('read_graph')).value.structuredContent, graph);
});

test('manual and automatic memory writes serialize, deduplicate, survive disable and reload', async t => {
  const f = await worker(t);
  const pid = f.status.pid;
  await f.native('create_entities', { entities: [{ name: 'shared', entityType: 'test', observations: [] }] });
  await Promise.all(Array.from({ length: 16 }, (_, i) => i % 2
    ? f.call('memory_remember', { observation: `Remember: preference ${i}` })
    : f.native('add_observations', { observations: [{ entityName: 'shared', contents: [`manual ${i}`] }] })));
  await Promise.all(Array.from({ length: 5 }, () => f.call('memory_remember', { observation: 'Remember: dedup' })));
  const before = await f.call('memory_recall');
  assert.equal(before.observations.length, 9);
  assert.equal((await f.native('open_nodes', { names: ['shared'] })).value.structuredContent.entities[0].observations.length, 8);
  await f.client.manage({ action: 'disable', id: 'dsh-memory' });
  await assert.rejects(f.call('memory_recall'), hasCode('CAPABILITY_UNAVAILABLE'));
  await writeFile(path.join(f.workspace, 'source.txt'), 'memory independent search');
  assert.ok(await f.call('knowledge_search', { query: 'independent' }));
  await f.client.manage({ action: 'enable', id: 'dsh-memory' });
  assert.deepEqual(await f.call('memory_recall'), before);
  await f.client.reload();
  assert.deepEqual(await f.call('memory_recall'), before);
  assert.equal((await f.client.status()).pid, pid);
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).memoryFilePath, undefined);
});

test('automatic memory uses worker principal identity, explicit graph is shared, permissions separate read/write', async t => {
  const f = await worker(t);
  const alice: Principal = { kind: 'agent', agentId: 'main', requester: { channel: 'chat', accountId: 'default', senderId: 'alice' } };
  const bob: Principal = { ...alice, requester: { ...alice.requester!, senderId: 'bob' } };
  await f.call('memory_remember', { observation: 'Remember: Alice likes tea' }, alice, ['memory:write']);
  const recalled = await f.call('memory_recall', {}, alice, ['memory:read']);
  assert.equal(recalled.entityName, resolveAutomaticMemorySubject({ agentId: 'main', ...alice.requester }, 'conest')!.entityName);
  assert.deepEqual((await f.call('memory_recall', {}, bob)).observations, []);
  assert.deepEqual((await f.call('memory_recall')).observations, []);
  assert.match(JSON.stringify(await f.native('read_graph')), /Alice likes tea/);
  await assert.rejects(f.call('memory_recall', { entityName: recalled.entityName }, bob), hasCode('INVALID_ARGUMENTS'));
  await assert.rejects(f.call('memory_remember', { observation: 'Remember: denied' }, alice, ['memory:read']), hasCode('PERMISSION_DENIED'));
  await assert.rejects(f.call('memory_recall', {}, alice, ['workspace:read']), hasCode('PERMISSION_DENIED'));
  const catalog = await f.client.catalog({ principal: alice, permissions: ['memory:read'] });
  assert.deepEqual(catalog.capabilities.map(c => c.name).sort(), ['dsh_mcp__reference_memory__open_nodes', 'dsh_mcp__reference_memory__read_graph', 'dsh_mcp__reference_memory__search_nodes', 'memory_recall']);
  await f.client.manage({ action: 'policy', policy: { agents: { main: { deny: ['memory_*'] } } } });
  await assert.rejects(f.call('memory_recall', {}, alice), hasCode('CAPABILITY_DENIED'));
  await assert.rejects(f.call('memory_remember', { observation: 'Remember: denied' }, alice), hasCode('CAPABILITY_DENIED'));
});

test('memory file has one worker owner and corrupt data is preserved on failure', async t => {
  const corrupt = '{malformed old data}\n';
  const f = await worker(t, corrupt);
  await assert.rejects(f.call('memory_remember', { observation: 'Remember: do not overwrite corruption' }));
  assert.equal(await readFile(f.file, 'utf8'), corrupt);
  const second = new BridgeClient({ ...f.options, configFile: undefined, workspaceRoot: f.workspace });
  t.after(() => second.stop());
  const status = await second.start();
  assert.equal(status.components.find(c => c.id === 'dsh-memory')?.state, 'blocked');
  await assert.rejects(second.invoke({ ...request(f.workspace, 'memory_recall'), permissions: ['memory:read'] }), hasCode('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(f.client.manage({ action: 'configure', id: 'dsh-memory', config: { file: path.join(f.root, 'different') } }), hasCode('INVALID_CONFIG'));
  await writeFile(f.configFile, JSON.stringify({ workspaceRoot: f.workspace, memoryFilePath: path.join(f.root, 'other.jsonl') }));
  await assert.rejects(f.client.reload(), hasCode('MEMORY_RESTART_REQUIRED'));
  assert.equal(await readFile(f.file, 'utf8'), corrupt);
});

test('automatic memory adapter rejects incognito and invalid sender identity before invoking worker', async t => {
  const f = await fixture(t);
  const calls: any[] = [];
  const access = createMemoryAccess({ async invoke(call) { calls.push(call); return { value: { observations: [] } }; } }, resolveConfig({ workspaceRoot: f.workspace, memoryFilePath: path.join(f.root, 'memory.jsonl') }), () => ({}));
  // Official incognito key format, not a guessed marker.
  await assert.rejects(access('memory_remember', { observation: 'Remember: private' }, { agentId: 'main', sessionKey: 'agent:main:dashboard:incognito-private' }), hasCode('MEMORY_INCOGNITO'));
  await assert.rejects(access('memory_recall', {}, { agentId: 'main', senderId: 'alice' }), hasCode('IDENTITY_UNAVAILABLE'));
  assert.equal(calls.length, 0);
  await access('memory_recall', {}, { agentId: 'main', channel: 'chat', senderId: 'alice' });
  assert.deepEqual(calls[0].principal.requester, { channel: 'chat', accountId: 'default', senderId: 'alice' });
  assert.deepEqual(calls[0].permissions, ['memory:read']);
});

test('Studio memory failure degrades recall and capture without failing the main task; incognito skips all memory hooks', async t => {
  const { registerStudio } = await import('../src/studio/index.js');
  const f = await fixture(t);
  const hooks = new Map<string, Function>();
  let invocations = 0;
  const stateDir = path.join(f.root, 'studio');
  const api = { pluginConfig: { studio: { stateDir } }, logger: { warn() {}, debug() {} }, config: {},
    registerService() {}, registerAgentHarness() {}, registerTool() {}, registerHttpRoute() {},
    session: { controls: { registerControlUiDescriptor() {} } }, on(name: string, fn: Function) { hooks.set(name, fn); },
  };
  registerStudio(api as any, f.workspace, { endRun() {} }, async () => { invocations++; throw new Error('unavailable'); }, {} as any);
  const context = { agentId: 'main', runId: 'run', sessionKey: 'agent:main:test' };
  const messages = [{ role: 'user', content: 'Remember: bounded preference' }];
  assert.equal(await hooks.get('before_prompt_build')!({ prompt: 'Remember: bounded preference', messages }, context), undefined);
  await hooks.get('agent_end')!({ success: true, messages }, context);
  assert.equal(invocations, 2);
  const activity = await readFile(path.join(stateDir, 'activity.jsonl'), 'utf8');
  assert.equal(activity.match(/"state":"unavailable"/g)?.length, 2);
  const privateContext = { ...context, sessionKey: 'agent:main:dashboard:incognito-test' };
  await hooks.get('before_prompt_build')!({ prompt: 'Remember: private', messages }, privateContext);
  await hooks.get('agent_end')!({ success: true, messages }, privateContext);
  await hooks.get('before_tool_call')!({ toolName: 'dsh_mcp__reference_memory__read_graph' }, privateContext);
  await hooks.get('after_tool_call')!({ toolName: 'dsh_mcp__reference_memory__read_graph' }, privateContext);
  assert.equal(invocations, 2);
  assert.equal(await readFile(path.join(stateDir, 'activity.jsonl'), 'utf8'), activity);
});

test('cancellation never replays a submitted mutation; memory child exits with its worker and data recovers', { skip: process.platform !== 'linux' }, async t => {
  const { eventually } = await import('./helpers.js');
  const f = await worker(t);
  await f.native('create_entities', { entities: [{ name: 'cancel-test', entityType: 'test', observations: [] }] });
  const pid = f.status.pid;
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
  let child: number | undefined;
  for (const candidate of children) if ((await readFile(`/proc/${candidate}/cmdline`, 'utf8')).includes('mcp-memory-server')) child = candidate;
  assert.ok(child);
  process.kill(child, 'SIGSTOP');
  t.after(() => { try { process.kill(child!, 'SIGCONT'); } catch {} });
  const controller = new AbortController();
  const input = { ...request(f.workspace, 'dsh_mcp__reference_memory__add_observations', { observations: [{ entityName: 'cancel-test', contents: ['once'] }] }), permissions: [...ALL_PERMISSIONS], signal: controller.signal };
  const cancelled = f.client.invoke(input).then(() => false, () => true);
  await eventually(async () => (await f.client.status()).active > 0);
  // Allow the pipe dispatch to reach the stopped native process.
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  assert.equal(await cancelled, true);
  const next = f.native('add_observations', { observations: [{ entityName: 'cancel-test', contents: ['after cancellation'] }] });
  process.kill(child, 'SIGCONT');
  await next;
  const values = (await f.native('read_graph')).value.structuredContent.entities[0].observations;
  assert.ok(values.includes('after cancellation'));
  assert.ok(values.filter((value: string) => value === 'once').length <= 1);
  process.kill(pid, 'SIGKILL');
  await eventually(async () => {
    try { const info = await readFile(`/proc/${child}/stat`, 'utf8'); return info.split(' ')[2] === 'Z'; }
    catch { return true; }
  });
  await eventually(() => f.client.getState().state === 'failed');
  await f.client.start();
  assert.deepEqual((await f.native('read_graph')).value.structuredContent.entities[0].observations, values);
});
