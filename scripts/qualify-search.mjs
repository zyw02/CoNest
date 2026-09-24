import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

// Only model decisions are fixtures: both real loops execute the registered tools.
export function searchProbeDecision(input, textContent) {
  const task = [...input.messages].reverse().find(m => m.role === 'user' && textContent(m).includes('SEARCH_PROBE '));
  if (!task) return;
  const probe = JSON.parse(textContent(task).match(/SEARCH_PROBE (\{[^\n]*\})/)[1]);
  const results = input.messages.filter(m => m.role === 'tool');
  const offered = input.tools.map(t => t.function.name);
  assert.equal(offered.includes(probe.tool), !probe.hidden, `Finalized tool surface: ${probe.tool}`);
  if (probe.generic) {
    if (!results.length) return { name: 'bridge_capabilities', args: {} };
    const catalog = JSON.parse(textContent(results[0]));
    const capability = catalog.capabilities.find(c => c.name === probe.tool);
    assert.equal(!!capability, !probe.error, 'Managed catalog must reflect lifecycle and authorization');
    if (capability) assert.equal(capability.provider.id, 'dsh-search');
    if (results.length === 1) return { name: 'bridge_invoke', args: { capability: probe.tool, generation: catalog.generation, args: probe.args } };
  } else if (!results.length) return { name: probe.tool, args: probe.args };
  assert.equal(results.length, probe.generic ? 2 : 1, 'Search probes must not retry a denial');
  const result = textContent(results.at(-1));
  assert.match(result, new RegExp(probe.error ?? probe.expect));
  return { final: 'SEARCH_PROBE_OK' };
}

export async function qualifyManagedSearch({ root, workspace, cli, env, manage, execute, gatewayUrl, token }) {
  const checks = [];
  const loops = ['dsh', 'openclaw'];
  const status = await manage('status');
  const pid = status.pid;
  const rpc = async (method, params) => JSON.parse((await execute(process.execPath, [cli, 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'], { cwd: workspace, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  async function start(loop, probe, agent = 'main') {
    const sessionKey = `agent:${agent}:search-${loop}-${randomUUID()}`;
    const selection = await rpc('chat.send', { sessionKey, message: `/model deepseek/deepseek-v4-flash --runtime ${loop === 'dsh' ? 'auto' : 'openclaw'}`, idempotencyKey: randomUUID() });
    if (selection.runId) await rpc('agent.wait', { runId: selection.runId, timeoutMs: 10000 });
    const completed = execute(process.execPath, [cli, 'agent', '--session-key', sessionKey, '--thinking', 'off', '--timeout', '60', '--json', '--message', `SEARCH_PROBE ${JSON.stringify(probe)}`],
      { cwd: workspace, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }).then(result => ({ result }), error => ({ error }));
    return { loop, probe, sessionKey, completed };
  }
  async function finish(run, aborted = false) {
    const { result, error } = await run.completed;
    if (error && !aborted) throw error;
    const value = JSON.parse(result?.stdout ?? error.stdout);
    if (aborted) {
      assert.equal(value.summary, 'aborted'); assert.equal(value.stopReason, 'rpc');
      const events = (await readFile(path.join(root, 'studio/activity.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(events.some(e => e.kind === 'memory.recall' && e.runId === value.runId && e.sessionKey === run.sessionKey && e.loop === run.loop));
    } else {
      assert.equal(value.result?.meta?.agentMeta?.agentHarnessId, run.loop, 'Actual loop must match selection');
      assert.ok(JSON.stringify(value).includes('SEARCH_PROBE_OK'), JSON.stringify(value));
    }
    checks.push({ loop: run.loop, probe: run.probe, runId: value.runId, aborted });
  }
  const run = async (loop, probe, agent) => finish(await start(loop, probe, agent));
  const probes = [
    { tool: 'knowledge_search', args: { query: 'bridge-evidence' }, expect: 'evidence.txt' },
    { tool: 'dsh_grep', args: { pattern: 'bridge-[e]vidence', path: '.', include: '*.txt' }, expect: 'Line 1:' },
    { tool: 'dsh_glob', args: { pattern: '*.txt' }, expect: 'evidence.txt' },
  ];
  for (const loop of loops) {
    for (const probe of probes) await run(loop, probe);
    await run(loop, { ...probes[1], generic: true });
    for (const tool of ['dsh_grep', 'dsh_glob']) await run(loop, { tool, args: { pattern: 'x', path: '..' }, error: 'PERMISSION_DENIED|authorized workspace' });
    for (const tool of ['dsh_grep', 'dsh_glob']) await run(loop, { tool, args: { pattern: 'x' }, generic: true, hidden: true, error: 'CAPABILITY_DENIED|policy.*denies' }, 'nosearchtools');
  }
  await manage('components', 'disable', 'dsh-search');
  for (const loop of loops) for (const probe of probes) await run(loop, { ...probe, error: 'CAPABILITY_UNAVAILABLE|unavailable|not available' });
  await manage('components', 'enable', 'dsh-search');
  for (const loop of loops) for (const probe of probes) await run(loop, probe);

  // Linux fixture: FIFO keeps the real packaged rg child active until host abort/revocation.
  if (process.platform === 'linux') {
    const fifo = path.join(workspace, 'search-wait.fifo');
    await execute('mkfifo', [fifo]);
    const children = async () => (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
    const eventually = async check => {
      const until = Date.now() + 20000;
      while (!await check()) { if (Date.now() > until) throw new Error('Search process state deadline exceeded'); await new Promise(r => setTimeout(r, 50)); }
    };
    for (const loop of loops) {
      const active = await start(loop, { tool: 'dsh_grep', args: { pattern: 'wait', path: fifo } });
      await eventually(async () => !!await children());
      const receipt = await callGatewayFromCli('chat.abort', { url: gatewayUrl, token, timeout: '15000', json: true }, { sessionKey: active.sessionKey }, { progress: false, scopes: ['operator.admin', 'operator.write'] });
      assert.equal(receipt.aborted, true);
      await finish(active, true);
      await eventually(async () => (await manage('status')).tasks === 0 && !await children());
      const revoked = await start(loop, { tool: 'dsh_grep', args: { pattern: 'wait', path: fifo }, error: 'POLICY_CHANGED|policy changed|cancel' });
      await eventually(async () => !!await children());
      const policyFile = path.join(root, 'search-policy.json');
      await writeFile(policyFile, JSON.stringify({ agents: { main: { deny: ['dsh_grep'] } } }));
      await manage('policy', 'set', policyFile);
      await finish(revoked);
      await eventually(async () => (await manage('status')).tasks === 0 && !await children());
      await writeFile(policyFile, '{}'); await manage('policy', 'set', policyFile);
      await run(loop, probes[1]);
    }
  }
  const end = await manage('status');
  assert.equal(end.pid, pid); assert.equal(end.tasks, 0); assert.equal(end.retiredGenerations, 0);
  return { sameWorker: true, realRipgrepCancellation: process.platform === 'linux', checks };
}
