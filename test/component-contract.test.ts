import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { BridgeRuntime } from '../src/runtime.js';
import { component, fixture, hasCode, invoke, request } from './helpers.js';
import { eventually } from './helpers.js';
import { randomUUID } from 'node:crypto';

test('component calls enforce transitive permissions, declared dependencies, cycles, and output contracts', async context => {
  const { root, workspace } = await fixture(context);
  const manifests = await Promise.all(['unprivileged', 'undeclared', 'recursive', 'invalid-output'].map(async id => {
    const name = id.replaceAll('-', '_');
    return await component(root, {
      id, version: '1.0.0', description: 'Contract fixture', entry: '', requires: id === 'unprivileged' ? { 'dsh-search': '^0.2.0' } : {},
      capabilities: [{ name, description: 'Contract fixture', inputSchema: { type: 'object' }, permissions: id === 'unprivileged' ? [] : ['workspace:read'],
        ...(id === 'invalid-output' ? { outputSchema: { type: 'boolean' } } : {}) }],
    }, `export default { inject: ['bridgeCapabilities'], apply(ctx) {
      ctx.bridgeCapabilities.register(ctx, '${name}', async (_args, invocation) => ${id === 'invalid-output' ? "'not-a-boolean'" : `ctx.bridgeCapabilities.invoke('${id === 'recursive' ? name : 'knowledge_search'}', { query: 'fixture' }, invocation)`});
    } };`);
  }));
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace, components: manifests }), () => {});
  try {
    const scope = { ...request(workspace, 'unprivileged'), permissions: [] };
    const grant = runtime.authorize(scope);
    await assert.rejects(runtime.invoke({ ...scope, authorization: grant.token }), hasCode('PERMISSION_DENIED'));
    await assert.rejects(invoke(runtime, workspace, 'undeclared'), hasCode('DEPENDENCY_UNDECLARED'));
    await assert.rejects(invoke(runtime, workspace, 'recursive'), hasCode('CAPABILITY_CYCLE'));
    await assert.rejects(invoke(runtime, workspace, 'invalid_output'), hasCode('INVALID_COMPONENT_RESULT'));
    await runtime.reload(resolveConfig({ workspaceRoot: workspace, components: manifests, permissions: [] }));
    const workerLimited = request(workspace, 'unprivileged');
    const workerGrant = runtime.authorize(workerLimited);
    await assert.rejects(runtime.invoke({ ...workerLimited, authorization: workerGrant.token }), hasCode('PERMISSION_DENIED'));
  } finally { await runtime.close(); }
});

test('live Cordis service loss deactivates dependent capabilities and listeners, then recovers without reload', async context => {
  const { root, workspace } = await fixture(context);
  const event = `live-service-${randomUUID()}`;
  const descriptor = (name: string) => ({ name, description: 'Live service fixture', inputSchema: { type: 'object' } });
  const transport = await component(root, {
    id: 'transport', version: '1.0.0', description: 'Service transport fixture', entry: '', requires: {},
    capabilities: [{ ...descriptor('transport_control'), permissions: ['workspace:read'] }],
  }, `export default { inject: ['bridgeCapabilities'], apply(ctx) {
    let release = ctx.provide('fixtureTransport', true);
    ctx.bridgeCapabilities.register(ctx, 'transport_control', async args => {
      if (args.enabled) release = ctx.provide('fixtureTransport', true);
      else await release();
      return true;
    });
  } };`);
  const provider = await component(root, {
    id: 'service-provider', version: '1.0.0', description: 'Live provider fixture', entry: '', requires: { transport: '^1.0.0' },
    capabilities: [{ ...descriptor('service_read'), permissions: ['workspace:read'] }],
  }, `export default { inject: ['bridgeCapabilities', 'fixtureTransport'], apply(ctx) {
    const listener = () => {};
    ctx.effect(() => { process.on('${event}', listener); return () => process.off('${event}', listener); });
    ctx.bridgeCapabilities.register(ctx, 'service_read', async (args, invocation) => {
      if (args.wait) await new Promise((_resolve, reject) => {
        invocation.signal.throwIfAborted();
        invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true });
      });
      return 'available';
    });
  } };`);
  const consumer = await component(root, {
    id: 'service-consumer', version: '1.0.0', description: 'Live consumer fixture', entry: '', requires: { 'service-provider': '^1.0.0' },
    capabilities: [{ ...descriptor('service_consume'), permissions: ['workspace:read'] }],
  }, `export default { inject: ['bridgeCapabilities'], apply(ctx) {
    const listener = () => {};
    ctx.effect(() => { process.on('${event}', listener); return () => process.off('${event}', listener); });
    ctx.bridgeCapabilities.register(ctx, 'service_consume', async (args, invocation) => ctx.bridgeCapabilities.invoke('service_read', args, invocation));
  } };`);
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace, components: [consumer, provider, transport] }), () => {});
  try {
    const revision = runtime.status().revision;
    assert.equal((await invoke(runtime, workspace, 'service_consume')).value, 'available');
    assert.equal(process.listenerCount(event), 2);
    const interrupted = assert.rejects(invoke(runtime, workspace, 'service_consume', { wait: true }), hasCode('CAPABILITY_UNAVAILABLE'));
    await eventually(() => runtime.status().tasks === 1);
    await invoke(runtime, workspace, 'transport_control', { enabled: false });
    await interrupted;
    await eventually(() => process.listenerCount(event) === 0);
    assert.equal(runtime.status().components.find(item => item.id === 'service-consumer')?.state, 'blocked');
    assert.ok(!runtime.status().capabilities.some(item => item.name === 'service_consume'));
    await assert.rejects(invoke(runtime, workspace, 'service_consume'), hasCode('CAPABILITY_UNAVAILABLE'));
    await invoke(runtime, workspace, 'transport_control', { enabled: true });
    await eventually(() => runtime.status().capabilities.some(item => item.name === 'service_consume'));
    assert.equal(process.listenerCount(event), 2);
    assert.equal(runtime.status().revision, revision);
    assert.equal((await invoke(runtime, workspace, 'service_consume')).value, 'available');
  } finally { await runtime.close(); }
  assert.equal(process.listenerCount(event), 0);
});

test('workspace aliases retain canonical one-use authority and shorthand configs validate defaults', async context => {
  const { root, workspace } = await fixture(context);
  const alias = path.join(root, 'alias');
  await symlink(workspace, alias);
  await writeFile(path.join(workspace, 'evidence.txt'), 'alias fixture\n');
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace }), () => {});
  try { assert.equal(((await invoke(runtime, alias, 'knowledge_search', { query: 'alias fixture' })).value as { totalMatches: number }).totalMatches, 1); }
  finally { await runtime.close(); }
  const manifest = await component(root, { id: 'required-config', version: '1.0.0', description: 'Required configuration fixture', entry: '', requires: {}, capabilities: [],
    configSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } }, 'export default { apply() {} };');
  assert.throws(() => resolveConfig({ workspaceRoot: workspace, components: [manifest] }), hasCode('INVALID_CONFIG'));
  assert.doesNotThrow(() => resolveConfig({ workspaceRoot: workspace, components: [{ manifest, config: { label: 'valid' } }] }));
});
