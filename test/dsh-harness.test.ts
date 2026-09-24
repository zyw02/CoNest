import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry';
import type { AgentHarnessAttemptResult, EmbeddedRunAttemptParamsV2 } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { createDshAgentHarness } from '../src/studio/dsh-agent-harness.js';
import type { AgentRunResult, CordisBridgeHost } from '../src/studio/cordis-bridge-host.js';

const result: AgentRunResult = { sessionId: 'session', provider: 'deepseek-official', model: 'deepseek-v4-flash',
  finalText: 'done', finalContent: [{ type: 'text', text: 'done' }], finalMediaUrls: [], turnReason: 'done',
  toolCalls: [], toolResults: [], eventCount: 0, modelIterations: 1, sessionReused: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

function terminal(result: AgentHarnessAttemptResult) {
  assert.ok('terminal' in result);
  return result.terminal.kind;
}

function tool(name: string, execute?: AnyAgentTool['execute']): AnyAgentTool {
  return { name, label: name, description: name, parameters: { type: 'object' },
    execute: execute ?? (async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} })) } as AnyAgentTool;
}
function fixture(surface: AnyAgentTool[], run: (tools: AnyAgentTool[]) => Promise<void>, overrides: Partial<EmbeddedRunAttemptParamsV2> = {}) {
  const ended: string[] = [];
  let hostActive = true;
  const controller = new AbortController();
  const params = { runId: 'run', sessionId: 'session', sessionKey: 'agent:main:test', agentId: 'main',
    provider: 'deepseek', modelId: 'deepseek-v4-flash', prompt: 'test', config: {}, workspaceDir: '/tmp', timeoutMs: 5000,
    abortSignal: controller.signal, hostCapabilities: { assertActive() { if (!hostActive) throw new Error('host expired'); }, createToolSurface: () => surface },
    ...overrides } as EmbeddedRunAttemptParamsV2;
  const harness = createDshAgentHarness({ timeoutMs: 5000, onRunEnded: runId => ended.push(runId),
    host: { async runHarnessAgent(options: { hostTools: AnyAgentTool[] }) { await run(options.hostTools); return result; } } as unknown as CordisBridgeHost });
  return { ended, controller, expire: () => { hostActive = false; }, run: () => harness.runAttempt(params) };
}

test('DSH admits managed tools only through the filtered host surface; disable and safe-deny cannot widen it', async () => {
  const names = ['read', 'knowledge_search', 'bridge_capabilities', 'bridge_invoke', 'cordis_agent_run'];
  for (const disabled of [true, false]) {
    const f = fixture(names.map(name => tool(name)), async tools => {
      assert.deepEqual(tools.map(item => item.name), disabled ? [] : ['bridge_capabilities', 'bridge_invoke']);
    }, { toolsAllow: ['knowledge_search', 'bridge_capabilities', 'bridge_invoke', 'cordis_agent_run'],
      pluginHarnessToolPolicySafeDeniedTools: ['knowledge_search'], disableTools: disabled });
    assert.equal(terminal(await f.run()), 'ok');
    assert.deepEqual(f.ended, ['run']);
  }
});

test('retained DSH tool proxies reject calls after success or failure, and always release the run', async () => {
  for (const fail of [true, false]) {
    let retained: AnyAgentTool | undefined;
    let calls = 0;
    const f = fixture([tool('bridge_invoke', async () => { calls++; return { content: [], details: {} }; })], async tools => {
      retained = tools[0];
      if (fail) throw new Error('loop failed');
    });
    assert.equal(terminal(await f.run()), fail ? 'failed' : 'ok');
    assert.deepEqual(f.ended, ['run']);
    await assert.rejects(retained!.execute('late', {}), /attempt ended/);
    assert.equal(calls, 0, 'A retained proxy must never enter the executor after its attempt');
  }
});

test('DSH forwards host cancellation to actual tool work and rejects results after host expiry', async () => {
  let received: AbortSignal | undefined;
  const f = fixture([tool('bridge_invoke', async (_id, _args, signal) => {
    received = signal;
    f.controller.abort(new Error('cancel owned run'));
    signal!.throwIfAborted();
    return { content: [], details: {} };
  })], async tools => { await tools[0]!.execute('active', {}); });
  assert.equal(terminal(await f.run()), 'aborted');
  assert.equal(received?.aborted, true);
  assert.deepEqual(f.ended, ['run']);

  const expired = fixture([tool('bridge_invoke', async () => {
    expired.expire();
    return { content: [{ type: 'text', text: 'late result' }], details: {} };
  })], async tools => { await tools[0]!.execute('active', {}); });
  assert.equal(terminal(await expired.run()), 'failed');
  assert.deepEqual(expired.ended, ['run']);
});
