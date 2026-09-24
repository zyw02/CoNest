import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { BridgeRuntime } from '../src/runtime.js';
import { component, eventually, fixture, hasCode, invoke, request } from './helpers.js';
import type { ComponentManifest, JsonObject } from '../src/types.js';

type Resource = { id: string; instance: string; alive: boolean; stops: number };

async function graphFixture(t: TestContext) {
  const { root, workspace } = await fixture(t);
  const event = `loader-graph-${randomUUID()}`;
  const resources: Resource[] = [];
  const record = (resource: Resource) => resources.push(resource);
  process.on(event, record);
  t.after(() => process.off(event, record));
  const prelude = `import { randomUUID } from 'node:crypto';
    import { once } from 'node:events';
    import net from 'node:net';
    function own(ctx, id) {
      const resource = { id, instance: randomUUID(), alive: true, stops: 0 };
      process.emit('${event}', resource);
      ctx.effect(() => {
        const listener = () => {};
        process.on('${event}:owned', listener);
        return () => { process.off('${event}:owned', listener); resource.alive = false; resource.stops++; };
      });
      return resource;
    }
    async function gate(args, invocation) {
      if (args.gate) await once(process, '${event}:' + args.gate, { signal: invocation.signal });
    }
  `;
  async function plugin(id: string, version: string, requires: Record<string, string>, body: string, inject: string[] = [], caps = [id + '_read']) {
    const manifest: ComponentManifest = {
      id, version, entry: '', description: 'Versioned Loader test', requires,
      capabilities: caps.map(name => ({ name, description: name, permissions: ['workspace:read'], inputSchema: { type: 'object' } })),
    };
    return component(root, manifest, `${prelude}
      export default { inject: ${JSON.stringify(['bridgeCapabilities', ...inject])}, async apply(ctx, config) {
        const resource = own(ctx, '${id}');
        ${body}
      } };`);
  }
  const a = await plugin('a', '1.0.0', {}, `
    ctx.provide('probeSource', { read: () => { if (!resource.alive) throw new Error('SOURCE_CLOSED'); return config.value ?? 'a1'; } });
    ctx.bridgeCapabilities.register(ctx, 'a_read', async () => ({ value: config.value ?? 'a1', instance: resource.instance }));
  `);
  const b = await plugin('b', '1.0.0', { a: '*' }, `
    ctx.bridgeCapabilities.register(ctx, 'b_read', async (args, invocation) => {
      await gate(args, invocation);
      const nested = await ctx.bridgeCapabilities.invoke('a_read', {}, invocation);
      return { ...nested, service: ctx.probeSource.read(), consumer: resource.instance, config: config.label ?? 'b1' };
    });
  `, ['probeSource']);
  const c = await plugin('c', '1.0.0', {}, `
    const cache = new Map();
    const server = net.createServer();
    ctx.effect(() => () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    ctx.bridgeCapabilities.register(ctx, 'c_read', async () => {
      cache.set('calls', (cache.get('calls') ?? 0) + 1);
      return { instance: resource.instance, port: server.address().port, calls: cache.get('calls') };
    });
  `);
  const config = (overrides: Record<string, JsonObject> = {}, extra: JsonObject = {}, manifests = [a, b, c]) => resolveConfig({
    workspaceRoot: workspace, components: manifests.map(manifest => ({ manifest, ...overrides[manifest] })),
    taskTtlMs: 10_000, maxConcurrent: 8, ...extra,
  });
  const runtime = await BridgeRuntime.create(config(), () => {});
  t.after(async () => {
    await runtime.close().catch(error => {
      if (!runtime.status().cleanupErrors?.length) throw error;
    });
    assert.ok(resources.every(resource => !resource.alive && resource.stops === 1), 'Every acquired resource closes exactly once');
    assert.equal(process.listenerCount(`${event}:owned`), 0);
  });
  return { runtime, workspace, resources, a, b, c, config, plugin,
    release: (name: string) => (process as EventEmitter).emit(`${event}:${name}`),
    waiting: (name: string) => process.listenerCount(`${event}:${name}`) > 0,
    read: (name: string, args: JsonObject = {}) => invoke(runtime, workspace, name, args),
  };
}

test('native Loader shares unchanged providers and preserves delayed nested routes across overlapping revisions', async t => {
  const f = await graphFixture(t);
  const baseline = (await f.read('b_read')).value as Record<string, unknown>;
  const c1 = (await f.read('c_read')).value as Record<string, unknown>;
  const first = f.read('b_read', { gate: 'first' });
  await eventually(() => f.waiting('first'));
  await f.runtime.reload(f.config({ [f.b]: { config: { label: 'b2' } } }));
  assert.equal(f.resources.filter(r => r.id === 'a').length, 1, 'Unchanged A is shared, not restarted');
  assert.equal(f.resources.filter(r => r.id === 'b' && r.alive).length, 2);
  const second = f.read('b_read', { gate: 'second' });
  await eventually(() => f.waiting('second'));
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a2' } }, [f.b]: { config: { label: 'b2' } } }));
  const current = (await f.read('b_read')).value as Record<string, unknown>;
  assert.equal(current.value, 'a2');
  assert.equal(current.service, 'a2');
  assert.notEqual(current.instance, baseline.instance);
  assert.notEqual(current.consumer, baseline.consumer);
  f.release('first');
  const old = (await first).value as Record<string, unknown>;
  assert.equal(old.value, 'a1');
  assert.equal(old.service, 'a1');
  assert.equal(old.consumer, baseline.consumer);
  assert.equal(f.resources.find(r => r.instance === baseline.instance)?.alive, true, 'Second leased graph still owns A1');
  f.release('second');
  const middle = (await second).value as Record<string, unknown>;
  assert.equal(middle.value, 'a1');
  assert.equal(middle.service, 'a1');
  assert.equal(middle.config, 'b2');
  assert.equal(middle.instance, baseline.instance);
  assert.notEqual(middle.consumer, old.consumer);
  assert.equal(f.resources.find(r => r.instance === baseline.instance)?.alive, false);
  const c2 = (await f.read('c_read')).value as Record<string, unknown>;
  assert.deepEqual(c2, { ...c1, calls: 2 });
  assert.equal(f.runtime.status().retiredGenerations, 0);
});

test('real DSH search infrastructure can coexist across a built-in revision change', async t => {
  const f = await graphFixture(t);
  await writeFile(path.join(f.workspace, 'source.txt'), 'versioned-search-canary\n');
  const searcher = await f.plugin('searcher', '1.0.0', { 'dsh-search': '^0.2.0' }, `
    ctx.bridgeCapabilities.register(ctx, 'searcher_read', async (args, invocation) => {
      await gate(args, invocation);
      return ctx.bridgeCapabilities.invoke('knowledge_search', { query: 'versioned-search-canary' }, invocation);
    });
  `);
  await f.runtime.reload(f.config({}, {}, [f.a, f.b, f.c, searcher]));
  const first = f.read('searcher_read', { gate: 'search' });
  await eventually(() => f.waiting('search'));
  await f.runtime.reload(f.config({}, { builtins: { 'dsh-search': { config: { revisionProbe: 2 } } } }, [f.a, f.b, f.c, searcher]));
  assert.equal(f.runtime.status().retiredGenerations, 1);
  assert.equal(((await f.read('searcher_read')).value as Record<string, unknown>).totalMatches, 1);
  f.release('search');
  assert.equal(((await first).value as Record<string, unknown>).totalMatches, 1);
  assert.equal(f.runtime.status().retiredGenerations, 0);
  for (const id of ['a', 'b', 'c']) assert.equal(f.resources.filter(r => r.id === id).length, 1);
});

test('failed activation and failed persistence discard only candidate resources and preserve accepted calls', async t => {
  const f = await graphFixture(t);
  const before = f.runtime.status().revision;
  const pending = f.read('b_read', { gate: 'held' });
  await eventually(() => f.waiting('held'));
  const bad = await f.plugin('a', '2.0.0', {}, `throw new Error('CANDIDATE_FAILED');`);
  await assert.rejects(f.runtime.reload(f.config({}, {}, [bad, f.b, f.c])), hasCode('UPGRADE_REJECTED'));
  assert.equal(f.runtime.status().revision, before);
  await assert.rejects(f.runtime.reload(f.config({ [f.a]: { config: { value: 'uncommitted' } } }), async () => {
    throw new Error('PERSISTENCE_FAILED');
  }), /PERSISTENCE_FAILED/);
  assert.equal(f.runtime.status().revision, before);
  assert.equal(f.resources.filter(r => r.id === 'a' && r.alive).length, 1);
  assert.equal(f.resources.filter(r => r.id === 'b' && r.alive).length, 1);
  f.release('held');
  assert.equal(((await pending).value as Record<string, unknown>).value, 'a1');
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
});

test('simultaneously finishing retained graphs can drain in reverse publication order', async t => {
  const f = await graphFixture(t);
  const first = f.read('b_read', { gate: 'first' });
  await eventually(() => f.waiting('first'));
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a2' } } }));
  const second = f.read('b_read', { gate: 'second' });
  await eventually(() => f.waiting('second'));
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a3' } } }));
  f.release('second');
  f.release('first');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(r => (r.value as Record<string, unknown>).value), ['a1', 'a2']);
  assert.equal(f.runtime.status().retiredGenerations, 0);
  assert.equal(f.resources.filter(r => r.id === 'a' && r.alive).length, 1);
});

test('Loader configuration never interprets JSON component values as executable expressions', async t => {
  const f = await graphFixture(t);
  const literal = { __jsExpr: "(() => { throw new Error('CONFIG_EXECUTED'); })()" };
  await f.runtime.reload(f.config({ [f.a]: { config: { value: literal } } }));
  assert.deepEqual(((await f.read('a_read')).value as Record<string, unknown>).value, literal);
});

test('no-op and scheduler-only revisions preserve every component instance and real resource', async t => {
  const f = await graphFixture(t);
  const before = [...f.resources];
  await f.runtime.reload(f.config());
  await f.runtime.reload(f.config({}, { maxConcurrent: 2 }));
  assert.deepEqual(f.resources, before);
  assert.ok(before.every(r => r.alive && r.stops === 0));
});

test('entry retirement awaits actual asynchronous cleanup while newly published calls remain usable', async t => {
  const f = await graphFixture(t);
  const release = `cleanup-release-${randomUUID()}`;
  const slow = await f.plugin('slow-cleanup', '1.0.0', {}, `
    ctx.effect(() => async () => { await once(process, '${release}'); });
    ctx.bridgeCapabilities.register(ctx, 'slow_cleanup_read', async () => true);
  `, [], ['slow_cleanup_read']);
  await f.runtime.reload(f.config({}, {}, [f.a, f.b, f.c, slow]));
  let settled = false;
  const removing = f.runtime.reload(f.config()).then(value => { settled = true; return value; });
  await eventually(() => process.listenerCount(release) === 1);
  assert.equal(settled, false);
  await assert.rejects(f.read('slow_cleanup_read'), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
  (process as EventEmitter).emit(release);
  await removing;
  assert.equal(settled, true);
});

test('native Loader management is not exposed as an implicitly injectable application service', async t => {
  const f = await graphFixture(t);
  const implicit = await f.plugin('implicit-loader', '1.0.0', {}, '', ['loader'], []);
  await assert.rejects(f.runtime.reload(f.config({}, {}, [f.a, f.b, f.c, implicit])), hasCode('UPGRADE_REJECTED'));
  assert.equal(f.resources.filter(r => r.id === 'implicit-loader').length, 0);
});

test('reloading a self-stopped entry creates one replacement without reviving the retired native entry', async t => {
  const f = await graphFixture(t);
  const stopping = await f.plugin('self-stop', '1.0.0', {}, `
    ctx.bridgeCapabilities.register(ctx, 'self_stop_read', async () => {
      await ctx.fiber.entry.fiber.dispose();
      return true;
    });
  `, [], ['self_stop_read']);
  const config = f.config({}, {}, [f.a, f.b, f.c, stopping]);
  await f.runtime.reload(config);
  await assert.rejects(f.read('self_stop_read'), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.equal(f.runtime.status().components.find(c => c.id === 'self-stop')?.state, 'blocked');
  await f.runtime.reload(config);
  assert.equal(f.resources.filter(r => r.id === 'self-stop').length, 2);
  assert.equal(f.resources.filter(r => r.id === 'self-stop' && r.alive).length, 1);
});

test('dependency removal blocks future calls while leased old graph retains its provider', async t => {
  const f = await graphFixture(t);
  const pending = f.read('b_read', { gate: 'held' });
  await eventually(() => f.waiting('held'));
  const result = await f.runtime.reload(f.config({ [f.a]: { enabled: false } }));
  assert.equal(result.components.find(c => c.id === 'b')?.state, 'blocked');
  await assert.rejects(f.read('b_read'), hasCode('CAPABILITY_UNAVAILABLE'));
  assert.equal(f.resources.find(r => r.id === 'a')?.alive, true);
  f.release('held');
  assert.equal(((await pending).value as Record<string, unknown>).value, 'a1');
  assert.equal(f.resources.find(r => r.id === 'a')?.alive, false);
  await f.runtime.reload(f.config());
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
});

test('candidate persistence is serialized, snapshots caller config, and preserves stale grant rejection', async t => {
  const f = await graphFixture(t);
  const entered = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const staleRequest = request(f.workspace, 'b_read');
  const stale = f.runtime.authorize(staleRequest);
  const config = f.config({ [f.a]: { config: { value: 'accepted' } } });
  const update = f.runtime.reload(config, async () => { entered.resolve(); await commit.promise; });
  config.components.find(c => c.manifest.id === 'a')!.config.value = 'mutated';
  await entered.promise;
  await assert.rejects(f.runtime.reload(f.config()), hasCode('RELOAD_BUSY'));
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
  commit.resolve();
  await update;
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'accepted');
  await assert.rejects(f.runtime.invoke({ ...staleRequest, authorization: stale.token }), hasCode('STALE_GENERATION'));
});

test('returning to identical configuration bytes never revives old catalog tokens or unused call grants', async t => {
  const f = await graphFixture(t);
  const req = request(f.workspace, 'b_read');
  const grant = f.runtime.authorize(req);
  await f.runtime.reload(f.config({ [f.a]: { enabled: false } }));
  await f.runtime.reload(f.config());
  assert.notEqual(f.runtime.status().revision, grant.generation);
  assert.throws(() => f.runtime.authorize({ ...request(f.workspace, 'b_read'), expectedGeneration: grant.generation }), hasCode('STALE_GENERATION'));
  await assert.rejects(f.runtime.invoke({ ...req, authorization: grant.token }), hasCode('STALE_GENERATION'));
});

test('retired revision limit rejects preparation before acquiring further resources, then recovers', async t => {
  const f = await graphFixture(t);
  const pending = f.read('b_read', { gate: 'held' });
  await eventually(() => f.waiting('held'));
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a2' } } }, { maxRetiredGenerations: 1 }));
  const acquired = f.resources.length;
  await assert.rejects(f.runtime.reload(f.config({ [f.a]: { config: { value: 'a3' } } }, { maxRetiredGenerations: 1 })), hasCode('RELOAD_BUSY'));
  assert.equal(f.resources.length, acquired);
  f.release('held');
  await pending;
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a3' } } }, { maxRetiredGenerations: 1 }));
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a3');
});

test('policy revocation aborts tasks across all retained revisions without keeping released providers alive', async t => {
  const f = await graphFixture(t);
  const first = assert.rejects(f.read('b_read', { gate: 'first' }), hasCode('POLICY_CHANGED'));
  await eventually(() => f.waiting('first'));
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a2' } } }));
  const second = assert.rejects(f.read('b_read', { gate: 'second' }), hasCode('POLICY_CHANGED'));
  await eventually(() => f.waiting('second'));
  await f.runtime.reload(f.config({ [f.a]: { config: { value: 'a2' } } }, { permissions: [] }));
  await Promise.all([first, second]);
  assert.equal(f.runtime.status().tasks, 0);
  assert.equal(f.runtime.status().retiredGenerations, 0);
  assert.equal(f.resources.filter(r => r.id === 'a' && r.alive).length, 1);
  await assert.rejects(f.read('b_read'), hasCode('PERMISSION_DENIED'));
});

test('cancellation while a candidate awaits persistence releases only old call leases', async t => {
  const f = await graphFixture(t);
  const req = request(f.workspace, 'b_read', { gate: 'held' });
  const grant = f.runtime.authorize(req);
  const stopped = assert.rejects(f.runtime.invoke({ ...req, authorization: grant.token }), hasCode('TASK_CANCELLED'));
  await eventually(() => f.waiting('held'));
  const entered = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const update = f.runtime.reload(f.config({ [f.a]: { config: { value: 'a2' } } }), async () => { entered.resolve(); await commit.promise; });
  await entered.promise;
  f.runtime.cancel(req.taskId, grant.token);
  await stopped;
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
  commit.resolve();
  await update;
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a2');
});

test('shutdown during candidate activation prevents persistence and drains both accepted and candidate resources', async t => {
  const f = await graphFixture(t);
  // Use a fixture-local activation event, never a real network or filesystem dependency.
  const activation = `activation-${randomUUID()}`;
  const gated = await f.plugin('a', '3.0.0', {}, `
    await once(process, '${activation}');
    ctx.provide('probeSource', { read: () => 'a3' });
    ctx.bridgeCapabilities.register(ctx, 'a_read', async () => true);
  `);
  let persisted = false;
  const update = assert.rejects(f.runtime.reload(f.config({}, {}, [gated, f.b, f.c]), async () => { persisted = true; }), hasCode('BRIDGE_STOPPING'));
  await eventually(() => process.listenerCount(activation) === 1);
  const closing = f.runtime.close();
  (process as EventEmitter).emit(activation);
  await update;
  await closing;
  assert.equal(persisted, false);
  assert.ok(f.resources.every(r => !r.alive));
});

test('settled unload with a logged disposer failure reports degraded cleanup instead of rollback success', async t => {
  const f = await graphFixture(t);
  const broken = await f.plugin('cleanup', '1.0.0', {}, `
    ctx.effect(() => () => { throw new Error('EXPECTED_CLEANUP_FAILURE'); });
    ctx.bridgeCapabilities.register(ctx, 'cleanup_read', async () => true);
  `);
  await f.runtime.reload(f.config({}, {}, [f.a, f.b, f.c, broken]));
  const result = await f.runtime.reload(f.config());
  assert.equal(result.state, 'degraded');
  assert.match(result.cleanupErrors?.join(' ') ?? '', /EXPECTED_CLEANUP_FAILURE/);
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
  await assert.rejects(f.runtime.close(), /shutdown cleanup failed/);
});

test('undeclared actual service injection is not satisfied from an unrelated accepted entry', async t => {
  const f = await graphFixture(t);
  const implicit = await f.plugin('implicit', '1.0.0', {}, `
    ctx.bridgeCapabilities.register(ctx, 'implicit_read', async () => ctx.probeSource.read());
  `, ['probeSource']);
  await assert.rejects(f.runtime.reload(f.config({}, {}, [f.a, f.b, f.c, implicit])), hasCode('UPGRADE_REJECTED'));
  assert.equal(((await f.read('b_read')).value as Record<string, unknown>).value, 'a1');
  assert.equal(f.resources.filter(r => r.id === 'a').length, 1);
});
