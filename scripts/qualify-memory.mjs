import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function memoryProbeDecision(input, textContent) {
  const text = [...input.messages].reverse().filter(m => m.role === 'user').map(textContent).find(t => t.includes('MEMORY_PROBE '));
  if (!text) return;
  const probe = JSON.parse([...text.matchAll(/MEMORY_PROBE (\{[^\n]*\})/g)].at(-1)[1]);
  const results = input.messages.filter(m => m.role === 'tool');
  if (probe.autoExpected !== undefined) {
    const memoryContext = input.messages.map(textContent).join('\n').match(/<dsh-automatic-memory>([\s\S]*?)<\/dsh-automatic-memory>/)?.[1] ?? '';
    assert.equal(memoryContext.includes('memory-stage-auto-marker'), probe.autoExpected, 'Automatic recall must match service availability');
  }
  if (!probe.tool) return { final: 'MEMORY_PROBE_OK' };
  assert.equal(input.tools.some(t => t.function.name === probe.tool), !probe.hidden);
  if (probe.generic) {
    if (!results.length) return { name: 'bridge_capabilities', args: {} };
    const catalog = JSON.parse(textContent(results[0]));
    const capability = catalog.capabilities.find(c => c.name === probe.tool);
    assert.equal(!!capability, !probe.error);
    if (capability) assert.equal(capability.provider.id, 'dsh-memory');
    if (results.length === 1) return { name: 'bridge_invoke', args: { capability: probe.tool, generation: catalog.generation, args: probe.args } };
  } else if (!results.length) return { name: probe.tool, args: probe.args };
  assert.equal(results.length, probe.generic ? 2 : 1, 'Memory mutation or denial must not be retried');
  assert.match(textContent(results.at(-1)), new RegExp(probe.error ?? probe.expect));
  return { final: 'MEMORY_PROBE_OK' };
}
export async function qualifyManagedMemory({ root, workspace, cli, env, manage, execute, http }) {
  const checks = [], pid = (await manage('status')).pid;
  const loops = ['dsh', 'openclaw'];
  const rpc = async (method, params) => JSON.parse((await execute(process.execPath, [cli, 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'], { cwd: workspace, env, timeout: 30000, maxBuffer: 4e6 })).stdout);
  const run = async (loop, probe, prefix = '', agent = 'main') => {
    const sessionKey = `agent:${agent}:memory-${loop}-${randomUUID()}`;
    const selection = await rpc('chat.send', { sessionKey, message: `/model deepseek/deepseek-v4-flash --runtime ${loop === 'dsh' ? 'auto' : 'openclaw'}`, idempotencyKey: randomUUID() });
    if (selection.runId) await rpc('agent.wait', { runId: selection.runId, timeoutMs: 10000 });
    const response = await execute(process.execPath, [cli, 'agent', '--session-key', sessionKey, '--thinking', 'off', '--timeout', '60', '--json', '--message', `${prefix}\nMEMORY_PROBE ${JSON.stringify(probe)}`], { cwd: workspace, env, timeout: 90000, maxBuffer: 4e6 });
    const value = JSON.parse(response.stdout);
    assert.equal(value.result?.meta?.agentMeta?.agentHarnessId, loop);
    assert.ok(JSON.stringify(value).includes('MEMORY_PROBE_OK'));
    checks.push({ loop, probe, runId: value.runId });
  };
  const name = 'dsh_mcp__reference_memory__';
  for (const loop of loops) {
    await run(loop, { tool: `${name}create_entities`, args: { entities: [{ name: `shared-${loop}`, entityType: 'test', observations: [`written-by-${loop}`] }] }, expect: `written-by-${loop}` });
    await run(loop, { tool: `${name}search_nodes`, args: { query: 'shared-' }, expect: 'written-by-dsh', generic: true });
  }
  await run('dsh', {}, 'Remember: memory-stage-auto-marker');
  // agent_end can finish after the reply RPC; wait for acknowledged persistence.
  const deadline = Date.now() + 10000;
  while (!JSON.stringify(await manage('invoke', 'memory_recall', '{}')).includes('memory-stage-auto-marker')) {
    assert.ok(Date.now() < deadline, 'Automatic write did not persist');
    await new Promise(r => setTimeout(r, 100));
  }
  for (const loop of loops) await run(loop, { autoExpected: true });
  const probe = { tool: `${name}search_nodes`, args: { query: 'shared-' }, expect: 'written-by-openclaw' };
  for (const loop of loops) await run(loop, { ...probe, generic: true, hidden: true, error: 'CAPABILITY_DENIED|policy.*denies' }, '', 'nomemorytool');
  const normalCatalog = await http('bridge_capabilities', {});
  assert.ok(!normalCatalog.body.result.details.capabilities.some(c => ['memory_recall', 'memory_remember'].includes(c.name)), 'Service hooks cannot be used as alternate model tool entries');
  const serviceBypass = await http('bridge_invoke', { capability: 'memory_recall', generation: normalCatalog.body.result.details.generation, args: {} });
  assert.notEqual(serviceBypass.status, 200);
  const incognito = 'agent:main:dashboard:incognito-memory-probe';
  const catalog = await http('bridge_capabilities', {}, incognito);
  assert.equal(catalog.status, 200);
  assert.ok(!catalog.body.result.details.capabilities.some(c => c.name.includes('memory')));
  const denied = await http('bridge_invoke', { capability: 'memory_recall', generation: catalog.body.result.details.generation, args: {} }, incognito);
  assert.notEqual(denied.status, 200);
  const direct = await http(`${name}read_graph`, {}, incognito);
  assert.notEqual(direct.status, 200);
  await manage('components', 'disable', 'dsh-memory');
  for (const loop of loops) await run(loop, { ...probe, autoExpected: false, error: 'CAPABILITY_UNAVAILABLE|unavailable|not available' });
  await manage('components', 'enable', 'dsh-memory');
  for (const loop of loops) await run(loop, { ...probe, autoExpected: true });
  const events = (await readFile(path.join(root, 'studio/activity.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.kind === 'memory.recall' && e.state === 'unavailable'));
  assert.ok(!events.some(e => e.sessionKey === incognito));
  assert.equal((await manage('status')).pid, pid);
  return { passed: true, tasks: checks, incognito: 'direct and generic blocked; no activity', failure: 'disabled service does not fail either loop', storage: 'legacy Studio memory.jsonl', model: 'local fixture, real loops and MCP memory' };
}
