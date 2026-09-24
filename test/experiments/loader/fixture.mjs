import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';

export const deferred = () => Promise.withResolvers();

/** Real Loader fixture; only application plugins and their resources are test-specific. */
export async function fixture(t) {
  const ctx = new Context();
  await ctx.plugin(Loader);
  const loader = ctx.loader;
  const bus = new EventEmitter();
  const started = { a: 0, b: 0, c: 0 };
  const stopped = { a: 0, b: 0, c: 0 };
  const resources = [];

  function own(owner, kind) {
    const resource = { kind, serial: ++started[kind], alive: true };
    resources.push(resource);
    owner.effect(() => {
      const listener = () => {};
      bus.on(kind, listener);
      return () => { bus.off(kind, listener); resource.alive = false; stopped[kind]++; };
    });
    return resource;
  }

  const provider = (value, fail = false) => ({
    name: `source-${value}${fail ? '-broken' : ''}`,
    apply(owner, config = {}) {
      const resource = own(owner, 'a');
      const service = {
        resource,
        read() {
          if (!resource.alive) throw new Error('SOURCE_CLOSED');
          return config.value ?? value;
        },
      };
      owner.provide('probeSource', service);
      if (fail) throw new Error('CANDIDATE_FAILED');
    },
  });
  loader.builtins.a1 = provider('v1');
  loader.builtins.a2 = provider('v2');
  loader.builtins.bad = provider('bad', true);
  loader.builtins.b = {
    name: 'consumer', inject: ['probeSource'],
    apply(owner) {
      const resource = own(owner, 'b');
      const source = owner.probeSource;
      owner.provide('probeConsumer', {
        resource, source,
        async read(gate = Promise.resolve()) {
          await gate;
          if (!resource.alive) throw new Error('CONSUMER_CLOSED');
          return source.read();
        },
      });
    },
  };
  loader.builtins.c = {
    name: 'unrelated',
    async apply(owner) {
      const resource = own(owner, 'c');
      const cache = new Map();
      const server = net.createServer();
      owner.effect(() => () => new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      }));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      owner.provide('probeUnrelated', { resource, cache, server });
    },
  };

  async function update(entries) {
    // Loader mutates entry option objects; each candidate must own its detached data.
    await loader.root.update(structuredClone(entries));
    await loader.await();
  }
  const read = (id, name) => loader.resolve(id).ctx.get(name);
  t.after(async () => {
    await loader.root.stop();
    await ctx.fiber.dispose();
    assert.equal(bus.eventNames().length, 0, 'All actual event listeners must be released');
    assert.ok(resources.every(resource => !resource.alive));
    assert.deepEqual(stopped, started, 'Every acquired resource must be disposed exactly once');
  });
  return { ctx, loader, bus, started, stopped, resources, update, read };
}

export const ordinary = (source = 'a1', config = {}) => [
  { id: 'A', name: `cordis:${source}`, config },
  { id: 'B', name: 'cordis:b' },
  { id: 'C', name: 'cordis:c' },
];

/** Versioned service labels let old and candidate graphs coexist in one Loader. */
export const versioned = (version, source = `a${version}`) => [
  { id: `A${version}`, name: `cordis:${source}`, isolate: { probeSource: `revision-${version}` } },
  { id: `B${version}`, name: 'cordis:b', isolate: { probeSource: `revision-${version}`, probeConsumer: `revision-${version}` } },
];
