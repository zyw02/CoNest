import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig, readConfig } from '../src/config.js';
import { configuredHostCeiling, hostPrincipal } from '../src/host-policy.js';
import { allowsCapability, parseCeiling, parsePolicy, policyRules } from '../src/policy.js';
import { BridgeRuntime } from '../src/runtime.js';
import { ComponentManager } from '../src/management.js';
import { RunScopes } from '../src/run-scope.js';
import type { Principal } from '../src/types.js';
import { component, eventually, fixture, hasCode, request } from './helpers.js';

const agent = (agentId: string): Principal => ({ kind: 'agent', agentId });

test('policy layers intersect, empty allow denies all, and malformed rules fail closed', () => {
  const policy = parsePolicy({ defaults: { allow: ['knowledge_*'], deny: ['*_verify'] }, agents: { reader: { allow: ['knowledge_search', 'knowledge_verify', 'secret'] } } });
  const rules = policyRules(policy, agent('reader'));
  assert.equal(allowsCapability('knowledge_search', rules), true);
  assert.equal(allowsCapability('knowledge_verify', rules), false);
  assert.equal(allowsCapability('secret', rules), false);
  assert.equal(allowsCapability('knowledge_search', [...rules, { allow: [] }]), false);
  assert.equal(allowsCapability('knowledge_search', policyRules(policy, agent('reader'), { deny: ['*'] })), false);
  assert.throws(() => parsePolicy({ default: {} }), hasCode('INVALID_POLICY'));
  assert.throws(() => parsePolicy({ defaults: { allow: ['group:plugins'] } }), hasCode('INVALID_POLICY'));
  assert.throws(() => parseCeiling({ allow: 'knowledge_search' }), hasCode('INVALID_POLICY'));
});

test('requester rules bind channel, account, and sender, with missing identity denied', () => {
  const requester = { channel: 'telegram', accountId: 'work', senderId: 'reader' };
  const policy = parsePolicy({ requesters: [{ ...requester, deny: ['knowledge_search'] }] });
  assert.equal(allowsCapability('knowledge_search', policyRules(policy, { kind: 'agent', agentId: 'main', requester })), false);
  assert.equal(allowsCapability('knowledge_search', policyRules(policy, { kind: 'agent', agentId: 'main', requester: { ...requester, accountId: 'personal' } })), false);
  assert.equal(allowsCapability('knowledge_verify', policyRules(policy, { kind: 'agent', agentId: 'main', requester })), true);
  assert.equal(allowsCapability('knowledge_search', policyRules(policy, agent('main'))), false);
  assert.equal(allowsCapability('knowledge_search', policyRules(policy, { kind: 'operator' })), true);
  assert.throws(() => hostPrincipal({}), hasCode('IDENTITY_UNAVAILABLE'));
  assert.deepEqual(hostPrincipal({ agentId: 'main', requesterSenderId: 'reader' }), agent('main'));
});

test('native host denies and allowlists narrow generic aliases across global, agent, and provider layers', () => {
  const config = { tools: { allow: ['knowledge_search', 'bridge_invoke'] }, agents: { entries: { reader: { tools: { deny: ['knowledge_search'], byProvider: { fixture: { deny: ['custom_*'] } } } } } } };
  const rules = [configuredHostCeiling(config, 'reader', { provider: 'fixture', modelId: 'test' })];
  for (const name of ['knowledge_search', 'knowledge_verify', 'custom_read']) assert.equal(allowsCapability(name, rules), false);
  assert.equal(allowsCapability('independent', rules), true);
  assert.equal(allowsCapability('custom_read', [configuredHostCeiling(config, 'reader')]), false);
  assert.equal(allowsCapability('knowledge_search', [configuredHostCeiling(config, 'writer')]), true);
  assert.equal(allowsCapability('anything', [configuredHostCeiling({ tools: { deny: ['group:plugins'] } }, 'main')]), false);
});

test('run policy snapshots only narrow, cannot survive run end, and fail closed when unavailable', () => {
  const scopes = new RunScopes(5000, 8);
  try {
    assert.throws(() => scopes.runDenials('unknown'), hasCode('HOST_POLICY_UNAVAILABLE'));
    scopes.restrictRun('run', ['knowledge_search']);
    scopes.restrictRun('run', []);
    assert.deepEqual(scopes.runDenials('run'), ['knowledge_search']);
    scopes.endRun('run');
    assert.throws(() => scopes.runDenials('run'), hasCode('HOST_POLICY_UNAVAILABLE'));
  } finally { scopes.close(); }
});

test('worker policy applies to catalog, direct calls, generic calls, nested calls, and operator ceilings', async context => {
  const { workspace } = await fixture(context);
  await writeFile(path.join(workspace, 'evidence.txt'), 'policy fixture\n');
  const progress: string[] = [];
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace, capabilityPolicy: { agents: { reader: { deny: ['knowledge_search'] } }, operator: { deny: ['knowledge_search'] } } }), event => progress.push(event.message));
  try {
    const denied = { ...request(workspace, 'knowledge_search', { query: 'policy' }), principal: agent('reader') };
    assert.throws(() => runtime.authorize(denied), hasCode('CAPABILITY_DENIED'));
    assert.equal(runtime.catalog(denied).capabilities.some(capability => capability.name === 'knowledge_search'), false);
    const nested = { ...denied, capability: 'knowledge_verify', args: { query: 'policy', quote: 'policy fixture' } };
    const grant = runtime.authorize(nested);
    await assert.rejects(runtime.invoke({ ...nested, authorization: grant.token }), hasCode('CAPABILITY_DENIED'));
    assert.equal(progress.includes('Searching workspace sources'), false, 'The denied dependency handler must never begin');
    assert.throws(() => runtime.authorize({ ...denied, principal: { kind: 'operator' } }), hasCode('CAPABILITY_DENIED'));
    const allowed = { ...denied, principal: agent('writer') };
    const allowedGrant = runtime.authorize(allowed);
    const result = await runtime.invoke({ ...allowed, authorization: allowedGrant.token });
    assert.equal((result.value as { totalMatches: number }).totalMatches, 1);
    assert.throws(() => runtime.authorize({ ...allowed, capabilityCeiling: { deny: ['knowledge_search'] } }), hasCode('CAPABILITY_DENIED'));
  } finally { await runtime.close(); }
});

test('one-use grants bind the principal and prevent widening the host capability ceiling', async context => {
  const { workspace } = await fixture(context);
  const runtime = await BridgeRuntime.create(resolveConfig({ workspaceRoot: workspace }), () => {});
  try {
    const input = { ...request(workspace, 'knowledge_search', { query: 'fixture' }), capabilityCeiling: { deny: ['knowledge_verify'] } };
    for (const change of [{ principal: agent('different-agent') }, { capabilityCeiling: {} }, { principal: { kind: 'operator' as const } }]) {
      const grant = runtime.authorize(input);
      await assert.rejects(runtime.invoke({ ...input, ...change, authorization: grant.token }), hasCode('AUTHORIZATION_MISMATCH'));
    }
    assert.throws(() => runtime.authorize({ ...input, principal: undefined as never }), hasCode('INVALID_PRINCIPAL'));
  } finally { await runtime.close(); }
});

test('a committed policy update revokes grants and cancels running and queued tasks without replay', async context => {
  const { root, workspace, configFile } = await fixture(context);
  const manifest = await component(root, { id: 'policy-waiter', version: '1.0.0', description: 'Policy revocation fixture', entry: '', requires: {},
    capabilities: [{ name: 'policy_wait', description: 'Wait for policy revocation', permissions: ['workspace:read'], inputSchema: { type: 'object' } }] },
  `export default { inject: ['bridgeCapabilities'], apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'policy_wait', async (_args, invocation) => {
      await new Promise((_resolve, reject) => { invocation.signal.throwIfAborted(); invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true }); });
    });
  } };`);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [manifest], maxConcurrent: 1 }));
  const runtime = await BridgeRuntime.create(readConfig(configFile), () => {});
  const manager = new ComponentManager(runtime, configFile);
  try {
    const pendingScope = request(workspace, 'policy_wait');
    const unspent = runtime.authorize(pendingScope);
    const start = () => { const scope = request(workspace, 'policy_wait'); const grant = runtime.authorize(scope); return runtime.invoke({ ...scope, authorization: grant.token }); };
    const first = assert.rejects(start(), hasCode('POLICY_CHANGED'));
    const second = assert.rejects(start(), hasCode('POLICY_CHANGED'));
    await eventually(() => runtime.status().active === 1 && runtime.status().queued === 1);
    const changed = await manager.apply({ action: 'policy', policy: { defaults: { deny: ['policy_wait'] } } });
    await Promise.all([first, second]);
    assert.equal(changed.capabilityPolicy.defaults.deny?.[0], 'policy_wait');
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')).capabilityPolicy.defaults, { deny: ['policy_wait'] });
    await assert.rejects(runtime.invoke({ ...pendingScope, authorization: unspent.token }), hasCode('AUTHORIZATION_INVALID'));
    assert.equal(runtime.status().tasks, 0);
    assert.throws(() => runtime.authorize(request(workspace, 'policy_wait')), hasCode('CAPABILITY_DENIED'));
    const contents = await readFile(configFile, 'utf8');
    await assert.rejects(manager.apply({ action: 'policy', policy: { defaults: { surprise: true } } }), hasCode('INVALID_POLICY'));
    assert.equal(await readFile(configFile, 'utf8'), contents);
  } finally { await runtime.close(); }
});
