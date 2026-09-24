import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, open, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

// Only model decisions are fixtures: both real loops execute the registered tools.
export function readProbeDecision(input, textContent) {
  const task = [...input.messages].reverse().find(m => m.role === 'user' && textContent(m).includes('READ_PROBE '));
  if (!task) return;
  const probe = JSON.parse(textContent(task).match(/READ_PROBE (\{[^\n]*\})/)[1]);
  const results = input.messages.filter(m => m.role === 'tool');
  const offered = input.tools.map(t => t.function.name);
  if (probe.steps) {
    assert.ok(results.length <= probe.steps.length);
    if (results.length) assert.match(textContent(results.at(-1)), new RegExp(probe.steps[results.length - 1].expect));
    const step = probe.steps[results.length];
    if (!step) return { final: 'READ_PROBE_OK' };
    assert.ok(offered.includes(step.tool));
    const args = step.tool === 'bridge_invoke' ? { ...step.args, generation: JSON.parse(textContent(results[0])).generation } : step.args;
    return { name: step.tool, args };
  }
  assert.equal(offered.includes(probe.tool), !probe.hidden, `Finalized tool surface: ${probe.tool}`);
  if (probe.generic) {
    if (!results.length) return { name: 'bridge_capabilities', args: {} };
    const catalog = JSON.parse(textContent(results[0]));
    const capability = catalog.capabilities.find(c => c.name === probe.tool);
    assert.equal(!!capability, !probe.error, 'Managed catalog must reflect lifecycle and authorization');
    if (capability) assert.equal(capability.provider.id, 'dsh-read');
    if (results.length === 1) return { name: 'bridge_invoke', args: { capability: probe.tool, generation: catalog.generation, args: probe.args } };
  } else if (!results.length) return { name: probe.tool, args: probe.args };
  assert.equal(results.length, probe.generic ? 2 : 1, 'Read probes must not retry a denial');
  const result = textContent(results.at(-1));
  assert.match(result, new RegExp(probe.error ?? probe.expect));
  return { final: 'READ_PROBE_OK' };
}

export async function qualifyManagedRead({ root, workspace, cli, env, manage, execute, gatewayUrl, token }) {
  const checks = [];
  const loops = ['dsh', 'openclaw'];
  const status = await manage('status');
  const pid = status.pid;
  const rpc = async (method, params) => JSON.parse((await execute(process.execPath, [cli, 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'], { cwd: workspace, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  async function start(loop, probe, agent = 'main') {
    const sessionKey = `agent:${agent}:read-${loop}-${randomUUID()}`;
    const selection = await rpc('chat.send', { sessionKey, message: `/model deepseek/deepseek-v4-flash --runtime ${loop === 'dsh' ? 'auto' : 'openclaw'}`, idempotencyKey: randomUUID() });
    if (selection.runId) await rpc('agent.wait', { runId: selection.runId, timeoutMs: 10000 });
    const completed = execute(process.execPath, [cli, 'agent', '--session-key', sessionKey, '--thinking', 'off', '--timeout', '60', '--json', '--message', `READ_PROBE ${JSON.stringify(probe)}`],
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
      assert.ok(JSON.stringify(value).includes('READ_PROBE_OK'), JSON.stringify(value));
    }
    checks.push({ loop: run.loop, probe: run.probe, runId: value.runId, aborted });
  }
  const run = async (loop, probe, agent) => finish(await start(loop, probe, agent));
  const probe = { tool: 'dsh_read', args: { file_path: 'evidence.txt', offset: 1, limit: 1 }, expect: '1: bridge-evidence' };
  for (const loop of loops) {
    await run(loop, probe);
    await run(loop, { ...probe, generic: true });
    await run(loop, { tool: 'dsh_read', args: { file_path: '../outside.txt' }, error: 'PERMISSION_DENIED|authorized workspace' });
    await run(loop, { ...probe, generic: true, hidden: true, error: 'CAPABILITY_DENIED|policy.*denies' }, 'noreadtool');
    const file = `edit-${loop}.txt`;
    await writeFile(path.join(workspace, file), 'before');
    await run(loop, { steps: [
      { tool: 'dsh_edit', args: { file_path: file, old_string: 'before', new_string: 'after' }, expect: 'requires reading|read the file' },
      { tool: 'dsh_read', args: { file_path: file }, expect: '1: before' },
      { tool: 'dsh_edit', args: { file_path: file, old_string: 'before', new_string: 'after' }, expect: 'updated successfully' },
      { tool: 'dsh_read', args: { file_path: file }, expect: '1: after' },
    ] });
    assert.equal(await readFile(path.join(workspace, file), 'utf8'), 'after');
    await run(loop, { steps: [
      { tool: 'bridge_capabilities', args: {}, expect: 'dsh_read' },
      { tool: 'bridge_invoke', args: { capability: 'dsh_read', args: { file_path: file } }, expect: '1: after' },
      { tool: 'dsh_write', args: { file_path: file, content: 'replaced' }, expect: 'Updated file' },
    ] });
    assert.equal(await readFile(path.join(workspace, file), 'utf8'), 'replaced');
  }
  await manage('components', 'disable', 'dsh-read');
  for (const loop of loops) await run(loop, { ...probe, error: 'CAPABILITY_UNAVAILABLE|unavailable|not available' });
  await manage('components', 'enable', 'dsh-read');
  for (const loop of loops) await run(loop, probe);

  // Observe an actual open file descriptor before host cancellation/revocation.
  if (process.platform === 'linux') {
    const file = path.join(workspace, 'read-stream.txt');
    const fd = await open(file, 'w');
    try { const block = Buffer.from('x\n'.repeat(512 * 1024)); for (let i = 0; i < 256; i++) await fd.write(block); } finally { await fd.close(); }
    const reading = async () => (await Promise.all((await readdir(`/proc/${pid}/fd`)).map(d => readlink(`/proc/${pid}/fd/${d}`).catch(() => '')))).includes(file);
    const eventually = async check => {
      const until = Date.now() + 20000;
      while (!await check()) { if (Date.now() > until) throw new Error('Read descriptor state deadline exceeded'); await new Promise(r => setTimeout(r, 5)); }
    };
    for (const loop of loops) {
      const active = await start(loop, { tool: 'dsh_read', args: { file_path: file } });
      await eventually(reading);
      const receipt = await callGatewayFromCli('chat.abort', { url: gatewayUrl, token, timeout: '15000', json: true }, { sessionKey: active.sessionKey }, { progress: false, scopes: ['operator.admin', 'operator.write'] });
      assert.equal(receipt.aborted, true);
      await finish(active, true);
      await eventually(async () => !await reading() && (await manage('status')).tasks === 0);
      const revoked = await start(loop, { tool: 'dsh_read', args: { file_path: file }, error: 'POLICY_CHANGED|policy changed|cancel' });
      await eventually(reading);
      const policyFile = path.join(root, 'read-policy.json');
      await writeFile(policyFile, JSON.stringify({ agents: { main: { deny: ['dsh_read'] } } }));
      await manage('policy', 'set', policyFile);
      await finish(revoked);
      await eventually(async () => !await reading() && (await manage('status')).tasks === 0);
      await writeFile(policyFile, '{}'); await manage('policy', 'set', policyFile);
      await run(loop, probe);
    }
  }
  const end = await manage('status');
  assert.equal(end.pid, pid); assert.equal(end.tasks, 0); assert.equal(end.retiredGenerations, 0);
  return { sameWorker: true, realStreamingReadCancellation: process.platform === 'linux', checks };
}
