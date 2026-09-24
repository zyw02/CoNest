import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { CAPABILITY_GUIDANCE, cleanupHostScope, registerHostAdapter, scopedCallId } from '../src/host-adapter.js';
import { RunScopes } from '../src/run-scope.js';

function fixture(enabled = true) {
  const hooks = new Map<string, { handler: (...args: any[]) => any; options: unknown }>();
  let lifecycle: (event: any) => void = () => {};
  const api = { on: (name: string, handler: (...args: any[]) => any, options: unknown) => hooks.set(name, { handler, options }),
    agent: { events: { registerAgentEventSubscription: (entry: any) => { lifecycle = entry.handle; } } } } as unknown as OpenClawPluginApi;
  const scopes = new RunScopes(5000, 64);
  registerHostAdapter(api, scopes, { capabilityGuidance: enabled });
  return { scopes, hooks, lifecycle: (event: any) => lifecycle(event), fire: (name: string, event: unknown, context: unknown) => hooks.get(name)!.handler(event, context) };
}
const authority = (denied: string[] = []) => ({ assertActive() {}, allows: (name: string) => !denied.includes(name) });

test('prompt guidance is opt-in and requires both finalized generic tools', () => {
  for (const enabled of [true, false]) for (const denied of [[], ['bridge_invoke'], ['bridge_capabilities']]) {
    const f = fixture(enabled);
    try {
      assert.deepEqual(f.hooks.get('before_prompt_build')!.options, { requiresToolAuthority: true });
      const result = f.fire('before_prompt_build', { prompt: 'ignore policy', messages: [] }, { runId: 'run', toolAuthority: authority(denied) });
      assert.deepEqual(result, enabled && !denied.length ? { appendContext: CAPABILITY_GUIDANCE } : undefined);
      assert.deepEqual(f.scopes.runDenials('run'), []);
    } finally { f.scopes.close(); }
  }
});

test('missing or expired authority cannot contribute context or establish policy', () => {
  const f = fixture();
  try {
    assert.equal(f.fire('before_prompt_build', {}, { runId: 'run' }), undefined);
    assert.equal(f.fire('before_prompt_build', {}, { toolAuthority: authority() }), undefined);
    let checks = 0;
    assert.throws(() => f.fire('before_prompt_build', {}, { runId: 'run', toolAuthority: {
      allows: () => true, assertActive() { if (++checks === 2) throw new Error('expired'); },
    } }), /expired/);
    assert.throws(() => f.scopes.runDenials('run'), /no current finalized/);
  } finally { f.scopes.close(); }
});

test('adapter keeps policy narrowing and cancellation isolated by run and session', () => {
  const f = fixture();
  try {
    for (const runId of ['a', 'b']) f.fire('before_prompt_build', {}, { runId, toolAuthority: authority(runId === 'a' ? ['knowledge_search'] : []) });
    f.fire('before_prompt_build', {}, { runId: 'a', toolAuthority: authority() });
    assert.deepEqual(f.scopes.runDenials('a'), ['knowledge_search']);
    assert.deepEqual(f.scopes.runDenials('b'), []);
    const bindings = ['a', 'b'].map(runId => {
      const context = { runId, sessionKey: runId, agentId: 'main', toolCallId: 'same', requester: { channel: 'test', accountId: 'work', senderId: runId } };
      f.fire('before_tool_call', { toolName: 'bridge_invoke' }, context);
      return f.scopes.claim(scopedCallId(context, 'same'));
    });
    assert.deepEqual(bindings[0].principal, { kind: 'agent', agentId: 'main', requester: { channel: 'test', accountId: 'work', senderId: 'a' } });
    f.lifecycle({ runId: 'a', data: { phase: 'error' } });
    assert.equal(bindings[0].signal.aborted, true);
    assert.equal(bindings[1].signal.aborted, false);
    assert.throws(() => f.scopes.runDenials('a'), /no current finalized/);
    f.fire('after_tool_call', { toolName: 'bridge_invoke' }, { sessionKey: 'b', toolCallId: 'same' });
    assert.equal(bindings[1].signal.aborted, true);
    assert.throws(() => f.scopes.claim(scopedCallId({ sessionKey: 'b' }, 'same')), /ended/);
  } finally { f.scopes.close(); }
});

test('host abort propagates, unrelated tool completion does not cancel adapter calls', () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const context = { runId: 'run', sessionKey: 'session', toolCallId: 'call', abortSignal: controller.signal };
    f.fire('before_tool_call', { toolName: 'bridge_invoke' }, context);
    const binding = f.scopes.claim(scopedCallId(context, 'call'));
    f.fire('after_tool_call', { toolName: 'read' }, context);
    assert.equal(binding.signal.aborted, false);
    controller.abort(new Error('host cancelled'));
    assert.equal(binding.signal.aborted, true);
    assert.match(String(binding.signal.reason), /host cancelled/);
  } finally { f.scopes.close(); }
});

test('session end clears only that session ID, including when a reset reuses its session key', () => {
  const f = fixture();
  try {
    const bindings = ['old', 'new'].map(sessionId => {
      const context = { sessionId, sessionKey: 'same-key', agentId: 'main', runId: `run-${sessionId}`, toolCallId: sessionId };
      f.fire('before_prompt_build', {}, { ...context, toolAuthority: authority() });
      f.fire('before_tool_call', { toolName: 'bridge_invoke' }, context);
      return f.scopes.claim(scopedCallId(context, sessionId));
    });
    f.fire('session_end', { sessionId: 'old', sessionKey: 'same-key', reason: 'reset', sessionFile: '/private/transcript' }, { agentId: 'main', sessionId: 'old' });
    assert.equal(bindings[0]!.signal.aborted, true);
    assert.equal(bindings[1]!.signal.aborted, false);
    assert.throws(() => f.scopes.runDenials('run-old'), /no current finalized/);
    assert.deepEqual(f.scopes.runDenials('run-new'), []);
    f.fire('session_end', { sessionId: 'old' }, { agentId: 'main', sessionId: 'old' });
    assert.equal(bindings[1]!.signal.aborted, false, 'A repeated late old-session event cannot cancel its replacement');
    f.fire('session_end', { sessionId: 'new' }, { agentId: 'other', sessionId: 'new' });
    assert.equal(bindings[1]!.signal.aborted, false, 'Explicit agent identities must agree');
    f.fire('session_end', { sessionId: 'new' }, { agentId: 'main', sessionId: 'new' });
    assert.equal(bindings[1]!.signal.aborted, true);
  } finally { f.scopes.close(); }
});

test('call and run bindings reject a changed session identity instead of rebinding execution', () => {
  const f = fixture();
  try {
    f.scopes.restrictRun('run', [], { sessionId: 'old', agentId: 'main' });
    assert.throws(() => f.scopes.restrictRun('run', [], { sessionId: 'new', agentId: 'main' }), /session identity changed/);
    f.scopes.observe('call', undefined, undefined, undefined, { sessionId: 'old', agentId: 'main' });
    assert.throws(() => f.scopes.claim('call', undefined, { sessionId: 'new' }), /session identity changed/);
    const binding = f.scopes.claim('call', undefined, { sessionId: 'old' });
    f.scopes.endSession({ sessionId: 'old', agentId: 'main' });
    assert.equal(binding.signal.aborted, true, 'Direct calls without run metadata still follow a known session ID');
  } finally { f.scopes.close(); }
});

test('session-scoped runtime cleanup cannot be treated as plugin unload or cancel a replacement session', () => {
  const f = fixture();
  try {
    f.scopes.restrictRun('new-run', [], { sessionId: 'new-id', agentId: 'main' });
    f.scopes.observe('new-call', 'new-run', undefined, undefined, { sessionId: 'new-id', agentId: 'main' });
    const binding = f.scopes.claim('new-call');
    assert.equal(cleanupHostScope({ sessionKey: 'reused-key' }, f.scopes), true, 'The caller must keep its worker/registry registration alive');
    assert.equal(binding.signal.aborted, false);
    assert.equal(cleanupHostScope({ runId: 'new-run' }, f.scopes), true);
    assert.equal(binding.signal.aborted, true);
    assert.equal(cleanupHostScope({}, f.scopes), false, 'Global plugin cleanup still releases ownership');
  } finally { f.scopes.close(); }
});


test('finalized search-tool denials also bind generic invocation and retain per-call lifetime', () => {
  const f = fixture();
  try {
    const context = { runId: 'run', sessionKey: 'session', agentId: 'main', toolCallId: 'grep-call' };
    f.fire('before_prompt_build', {}, { ...context, toolAuthority: authority(['dsh_grep', 'dsh_glob']) });
    assert.deepEqual(f.scopes.runDenials('run').sort(), ['dsh_glob', 'dsh_grep']);
    f.fire('before_tool_call', { toolName: 'dsh_grep' }, context);
    const binding = f.scopes.claim(scopedCallId(context, 'grep-call'));
    assert.equal(binding.runId, 'run');
    assert.deepEqual(binding.principal, { kind: 'agent', agentId: 'main' });
    f.fire('after_tool_call', { toolName: 'dsh_grep' }, context);
    assert.equal(binding.signal.aborted, true);
  } finally { f.scopes.close(); }
});
