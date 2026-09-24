import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readConfig } from '../src/config.js';
import { ComponentManager } from '../src/management.js';
import { BridgeRuntime } from '../src/runtime.js';
import type { ComponentManifest } from '../src/types.js';
import { component, fixture, hasCode, invoke, request } from './helpers.js';

test('installation, dependency recovery, configuration, disable, and uninstall change live capabilities and release listeners', async context => {
  const { root, workspace, configFile } = await fixture(context);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [] }));
  const event = `dsh-test-${randomUUID()}`;
  const provider = await fixtureComponent(root, 'provider', '1.0.0', event);
  const consumer = await fixtureComponent(root, 'consumer', '1.0.0', event, { provider: '^1.0.0' });
  const runtime = await BridgeRuntime.create(readConfig(configFile), () => {});
  const manager = new ComponentManager(runtime, configFile);
  try {
    const waiting = await manager.apply({ action: 'install', manifest: consumer });
    assert.equal(waiting.components.find(item => item.id === 'consumer')?.state, 'blocked');
    assert.equal(process.listenerCount(event), 0, 'The blocked consumer must not run its activation body');
    assert.equal(waiting.capabilities.some(item => item.name === 'consumer_read'), false);

    const ready = await manager.apply({ action: 'install', manifest: provider });
    assert.equal(ready.components.find(item => item.id === 'consumer')?.state, 'ready');
    assert.equal(process.listenerCount(event), 2);
    assert.equal((await invoke(runtime, workspace, 'consumer_read')).value, '1.0.0:default');
    const descriptor = ready.capabilities.find(item => item.name === 'consumer_read')!;
    assert.deepEqual(descriptor.provider, { id: 'consumer', version: '1.0.0' });

    await manager.apply({ action: 'configure', id: 'provider', config: { label: 'configured' } });
    assert.equal((await invoke(runtime, workspace, 'consumer_read')).value, '1.0.0:configured');
    assert.equal(process.listenerCount(event), 2, 'Previous generation listeners must be disposed');

    await manager.apply({ action: 'disable', id: 'provider' });
    assert.equal(process.listenerCount(event), 0);
    await assert.rejects(invoke(runtime, workspace, 'consumer_read'), hasCode('CAPABILITY_UNAVAILABLE'));
    await writeFile(path.join(workspace, 'native.txt'), 'unrelated search still works\n');
    assert.equal(((await invoke(runtime, workspace, 'knowledge_search', { query: 'unrelated' })).value as { totalMatches: number }).totalMatches, 1);

    await manager.apply({ action: 'enable', id: 'provider' });
    assert.equal(process.listenerCount(event), 2);
    await manager.apply({ action: 'uninstall', id: 'consumer' });
    assert.equal(process.listenerCount(event), 1);
    assert.equal(runtime.status().capabilities.some(item => item.name === 'consumer_read'), false);
    assert.equal((await invoke(runtime, workspace, 'provider_read')).value, '1.0.0:configured');
    await manager.apply({ action: 'uninstall', id: 'provider' });
    assert.equal(process.listenerCount(event), 0);
    assert.deepEqual((JSON.parse(await readFile(configFile, 'utf8')) as { components: unknown[] }).components, []);
  } finally { await runtime.close(); }
  assert.equal(process.listenerCount(event), 0);
});

test('failed upgrades preserve old code and persisted configuration, and successful upgrades pin active work', async context => {
  const { root, workspace, configFile } = await fixture(context);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [] }));
  const event = `dsh-upgrade-${randomUUID()}`;
  const versionOne = await fixtureComponent(root, 'provider', '1.0.0', event);
  const versionTwo = await fixtureComponent(root, 'provider', '1.1.0', event);
  const broken = await fixtureComponent(root, 'provider', '1.2.0', event, {}, true);
  const incompatible = await fixtureComponent(root, 'provider', '2.0.0', event);
  const consumer = await fixtureComponent(root, 'consumer', '1.0.0', event, { provider: '^1.0.0' });
  const runtime = await BridgeRuntime.create(readConfig(configFile), () => {});
  const manager = new ComponentManager(runtime, configFile);
  try {
    await manager.apply({ action: 'install', manifest: versionOne });
    await manager.apply({ action: 'install', manifest: consumer });
    const oldRevision = runtime.status().revision;
    const oldConfig = await readFile(configFile, 'utf8');
    await assert.rejects(manager.apply({ action: 'upgrade', id: 'provider', manifest: broken }), hasCode('UPGRADE_REJECTED'));
    assert.equal(runtime.status().revision, oldRevision);
    assert.equal(await readFile(configFile, 'utf8'), oldConfig);
    assert.equal((await invoke(runtime, workspace, 'consumer_read')).value, '1.0.0:default');
    assert.equal(process.listenerCount(event), 2, 'The failed candidate must release its listener');
    await assert.rejects(manager.apply({ action: 'upgrade', id: 'provider', manifest: incompatible }), hasCode('UPGRADE_REJECTED'));
    assert.equal(runtime.status().revision, oldRevision);
    assert.equal(await readFile(configFile, 'utf8'), oldConfig);

    const input = request(workspace, 'provider_read', { delayMs: 150 });
    const grant = runtime.authorize(input);
    const oldWork = runtime.invoke({ ...input, authorization: grant.token });
    const changed = await manager.apply({ action: 'upgrade', id: 'provider', manifest: versionTwo });
    assert.equal(changed.retiredGenerations, 1);
    assert.equal((await oldWork).value, '1.0.0:default');
    assert.equal((await invoke(runtime, workspace, 'consumer_read')).value, '1.1.0:default');
    assert.equal(runtime.status().retiredGenerations, 0);
    assert.equal(process.listenerCount(event), 2);
    await assert.rejects(manager.apply({ action: 'disable', id: 'provider', expectedRevision: oldRevision }), hasCode('STALE_REVISION'));
    await assert.rejects(manager.apply({ action: 'configure', id: 'provider', config: { label: 1 } }), hasCode('INVALID_CONFIG'));
    assert.equal((await invoke(runtime, workspace, 'consumer_read')).value, '1.1.0:default');
  } finally { await runtime.close(); }
  assert.equal(process.listenerCount(event), 0);
});

async function fixtureComponent(root: string, id: string, version: string, event: string, requires: Record<string, string> = {}, broken = false): Promise<string> {
  const manifest: ComponentManifest = {
    id, version, description: 'A lifecycle fixture with a managed process listener', entry: '', requires,
    bridgeVersion: '^0.6.0',
    configSchema: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } },
    capabilities: [{
      name: `${id}_read`, description: 'Read the provider fixture version', permissions: ['workspace:read'],
      inputSchema: { type: 'object', additionalProperties: false, properties: { delayMs: { type: 'integer', minimum: 0, maximum: 1000 } } },
      outputSchema: { type: 'string' },
    }],
  };
  return await component(root, manifest, `export default {
    name: '${id}', inject: ['bridgeCapabilities'],
    apply(ctx, config) {
      ctx.effect(() => {
        const listener = () => {};
        process.on('${event}', listener);
        return () => process.off('${event}', listener);
      });
      ${broken ? "throw new Error('Candidate activation failed');" : ''}
      ctx.bridgeCapabilities.register(ctx, '${id}_read', async (args, invocation) => {
        if (args.delayMs) await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(invocation.signal.reason); };
          const timer = setTimeout(() => { invocation.signal.removeEventListener('abort', abort); resolve(); }, args.delayMs);
          invocation.signal.addEventListener('abort', abort, { once: true });
        });
        ${id === 'consumer' ? "return await ctx.bridgeCapabilities.invoke('provider_read', {}, invocation);" : `return '${version}:' + (config.label ?? 'default');`}
      });
    },
  };`);
}
