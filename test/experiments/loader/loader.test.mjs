import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, fixture, ordinary, versioned } from './fixture.mjs';

test('native Loader reuses unchanged entries and preserves unrelated cache, listener, and live port', async t => {
  const f = await fixture(t);
  await f.update(ordinary());
  const original = f.read('C', 'probeUnrelated');
  const fiber = f.loader.resolve('C').fiber;
  const port = original.server.address().port;
  original.cache.set('survives', 42);
  await f.update(ordinary());
  assert.deepEqual(f.started, { a: 1, b: 1, c: 1 });
  await f.update(ordinary('a2'));
  assert.equal(await f.read('B', 'probeConsumer').read(), 'v2');
  assert.equal(f.read('C', 'probeUnrelated'), original);
  assert.equal(f.loader.resolve('C').fiber, fiber);
  assert.equal(original.cache.get('survives'), 42);
  assert.equal(original.server.address().port, port);
  assert.equal(f.bus.listenerCount('c'), 1);
  assert.equal(f.started.c, 1);
  assert.equal(f.stopped.c, 0);
  assert.equal(f.started.a, 2);
  assert.equal(f.stopped.a, 1);
  assert.ok(f.started.b >= 2);
  assert.equal(f.started.b - f.stopped.b, 1);
});

test('configuration updates and dependency disable/recovery leave the unrelated instance intact', async t => {
  const f = await fixture(t);
  await f.update(ordinary());
  const original = f.read('C', 'probeUnrelated');
  await f.update(ordinary('a1', { value: 'configured' }));
  assert.equal(await f.read('B', 'probeConsumer').read(), 'configured');
  const disabled = ordinary('a1', { value: 'configured' });
  disabled[0].disabled = true;
  await f.update(disabled);
  assert.equal(f.ctx.get('probeConsumer'), undefined);
  assert.equal(f.bus.listenerCount('a'), 0);
  assert.equal(f.bus.listenerCount('b'), 0);
  await f.update(ordinary('a1', { value: 'configured' }));
  assert.equal(await f.read('B', 'probeConsumer').read(), 'configured');
  assert.equal(f.read('C', 'probeUnrelated'), original);
  assert.equal(f.started.c, 1);
});

test('failed import preserves the active instance; failed activation restores functionality but not instance identity', async t => {
  const f = await fixture(t);
  await f.update(ordinary());
  const original = f.read('A', 'probeSource');
  const unrelated = f.read('C', 'probeUnrelated');
  const invalidImport = ordinary();
  invalidImport[0].name = 'file:///nonexistent/conest-loader-probe.mjs';
  await assert.rejects(f.update(invalidImport), /failed to import/);
  assert.equal(f.read('A', 'probeSource'), original);
  await assert.rejects(f.update(ordinary('bad')), /CANDIDATE_FAILED/);
  await f.loader.await();
  assert.equal(await f.read('B', 'probeConsumer').read(), 'v1');
  assert.notEqual(f.read('A', 'probeSource'), original);
  assert.equal(original.resource.alive, false);
  assert.equal(f.read('C', 'probeUnrelated'), unrelated);
  assert.equal(f.loader.resolve('A').options.name, 'cordis:a1');
  assert.equal(f.bus.listenerCount('a'), 1);
});

test('direct entry replacement does not drain application calls before disposing their resources', async t => {
  const f = await fixture(t);
  await f.update(ordinary());
  const admitted = f.read('B', 'probeConsumer');
  const gate = deferred();
  const result = admitted.read(gate.promise).then(value => ({ value }), error => ({ error }));
  await f.update(ordinary('a2'));
  assert.equal(admitted.resource.alive, false);
  gate.resolve();
  assert.match((await result).error.message, /CONSUMER_CLOSED|SOURCE_CLOSED/);
  assert.equal(await f.read('B', 'probeConsumer').read(), 'v2');
});

test('isolated candidate failure preserves accepted instances and admitted work', async t => {
  const f = await fixture(t);
  const accepted = [...versioned(1), { id: 'C', name: 'cordis:c' }];
  await f.update(accepted);
  const before = f.read('B1', 'probeConsumer');
  const gate = deferred();
  const result = before.read(gate.promise);
  t.after(() => gate.resolve());
  await assert.rejects(f.update([...accepted, ...versioned(2, 'bad')]), /CANDIDATE_FAILED/);
  assert.equal(f.read('B1', 'probeConsumer'), before);
  assert.equal(before.resource.alive, true);
  assert.ok(!f.loader.store.A2 && !f.loader.store.B2);
  assert.equal(f.started.c, 1);
  gate.resolve();
  assert.equal(await result, 'v1');
});

test('isolated versions coexist until the caller releases old work, then Loader disposes only retired entries', async t => {
  const f = await fixture(t);
  const c = { id: 'C', name: 'cordis:c' };
  const oldEntries = versioned(1);
  await f.update([...oldEntries, c]);
  const oldConsumer = f.read('B1', 'probeConsumer');
  const unrelated = f.read('C', 'probeUnrelated');
  const gate = deferred();
  const oldCall = oldConsumer.read(gate.promise);
  t.after(() => gate.resolve());
  await f.update([...oldEntries, ...versioned(2), c]);
  assert.equal(oldConsumer.resource.alive, true);
  assert.equal(await f.read('B2', 'probeConsumer').read(), 'v2');
  assert.equal(f.bus.listenerCount('a'), 2);
  gate.resolve();
  assert.equal(await oldCall, 'v1');
  // Production must tie this retirement decision to immutable call/graph leases.
  await f.update([...versioned(2), c]);
  assert.equal(oldConsumer.resource.alive, false);
  assert.equal(f.bus.listenerCount('a'), 1);
  assert.equal(f.bus.listenerCount('b'), 1);
  assert.equal(f.read('C', 'probeUnrelated'), unrelated);
  assert.equal(unrelated.server.listening, true);
});

test('entry removal waits for asynchronous cleanup to settle', async t => {
  const f = await fixture(t);
  const begun = deferred();
  const release = deferred();
  let cleaned = false;
  f.loader.builtins.slow = { apply(ctx) { ctx.effect(() => async () => {
    begun.resolve();
    await release.promise;
    cleaned = true;
  }); } };
  await f.update([{ id: 'slow', name: 'cordis:slow' }]);
  let finished = false;
  const removal = f.update([]).then(() => { finished = true; });
  await begun.promise;
  assert.equal(finished, false);
  assert.equal(cleaned, false);
  release.resolve();
  await removal;
  assert.equal(cleaned, true);
  assert.equal(f.loader.store.slow, undefined);
});

test('settled Loader entries with missing dependencies are pending, not ready for publication', async t => {
  const f = await fixture(t);
  await f.update([{ id: 'B', name: 'cordis:b' }]);
  assert.ok(f.loader.store.B.fiber);
  assert.equal(f.read('B', 'probeConsumer'), undefined);
  assert.equal(f.started.b, 0);
  await f.update(ordinary());
  assert.equal(await f.read('B', 'probeConsumer').read(), 'v1');
});

test('duplicate entry IDs are rejected before accepted entries or resources change', async t => {
  const f = await fixture(t);
  await f.update(ordinary());
  const source = f.read('A', 'probeSource');
  const before = { ...f.started };
  await assert.rejects(f.update([...ordinary(), { id: 'A', name: 'cordis:a2' }]), /duplicate loader entry id/);
  assert.equal(f.read('A', 'probeSource'), source);
  assert.deepEqual(f.started, before);
});

test('cleanup errors are logged while removal settles, so settled removal is not proof of clean disposal', async t => {
  const f = await fixture(t);
  let otherCleanupRan = false;
  f.loader.builtins.cleanupFailure = { apply(ctx) {
    ctx.effect(() => () => { throw new Error('EXPECTED_CLEANUP_FAILURE'); });
    ctx.effect(() => () => { otherCleanupRan = true; });
  } };
  await f.update([{ id: 'failing-cleanup', name: 'cordis:cleanupFailure' }]);
  await f.update([]);
  assert.equal(otherCleanupRan, true);
  assert.equal(f.loader.store['failing-cleanup'], undefined);
  assert.ok(f.ctx.logger.buffer.some(message => message.type === 'error'
    && message.args.some(value => String(value).includes('EXPECTED_CLEANUP_FAILURE'))));
});
