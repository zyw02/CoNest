import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

// Model decisions only. The actual Gateway, DSH loop and worker execute every call.
export function componentProbeDecision(input, textContent) {
  const task = [...input.messages].reverse().find(message => message.role === 'user' && textContent(message).includes('COMPONENT_PROBE '));
  if (!task) return;
  const probe = JSON.parse(textContent(task).match(/COMPONENT_PROBE (\{[^\n]*\})/)[1]);
  const results = input.messages.filter(message => message.role === 'tool');
  assert.ok(results.length <= 2, 'A component probe cannot retry or recurse');
  if (!results.length) return { name: 'bridge_capabilities', args: {} };
  const catalog = JSON.parse(textContent(results[0]));
  const capability = catalog.capabilities.find(item => item.name === probe.capability);
  if (probe.available !== undefined) {
    assert.equal(!!capability, probe.available, 'Discovery must reflect live component/policy state');
    if (!probe.invokeDenied) return { final: 'COMPONENT_PROBE_OK' };
  } else assert.ok(capability, `Missing ${probe.capability}`);
  if (results.length === 1) return { name: 'bridge_invoke', args: { capability: probe.capability, generation: catalog.generation, args: probe.args ?? {} } };
  const text = textContent(results[1]);
  if (probe.error) assert.match(text, new RegExp(probe.error, 'i'));
  else {
    const value = JSON.parse(text);
    if (probe.version) assert.equal(value.version, probe.version, 'An admitted call must retain its implementation version');
    assert.equal(value.verified, true, 'The component must actually invoke its source-verifier dependency');
  }
  return { final: 'COMPONENT_PROBE_OK' };
}

export async function qualifyDualLoopComponents({ root, workspace, cli, env, manage, execute, quote, marker, gatewayUrl, token }) {
  const loops = ['dsh', 'openclaw'];
  const checks = [];
  const control = path.join(root, 'component-probe-control');
  await mkdir(control);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function eventually(check, label) {
    const deadline = Date.now() + 30_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await sleep(50);
    }
  }
  async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  const rpc = async (method, params) => {
    const { stdout } = await execute(process.execPath, [cli, 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'], { cwd: workspace, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  async function start(loop, probe) {
    const sessionKey = `agent:main:components-${loop}-${randomUUID()}`;
    const selection = await rpc('chat.send', { sessionKey, message: `/model deepseek/deepseek-v4-flash --runtime ${loop === 'dsh' ? 'auto' : 'openclaw'}`, idempotencyKey: randomUUID() });
    if (selection.runId) await rpc('agent.wait', { runId: selection.runId, timeoutMs: 10_000 });
    const completed = execute(process.execPath, [cli, 'agent', '--session-key', sessionKey, '--thinking', 'off', '--timeout', '60', '--json', '--message', `COMPONENT_PROBE ${JSON.stringify(probe)}`],
      { cwd: workspace, env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }).then(result => ({ result }), error => ({ error }));
    return { loop, probe, sessionKey, completed };
  }
  async function finish(run, aborted = false) {
    const { result, error } = await run.completed;
    if (error && !aborted) throw error;
    const value = JSON.parse(result?.stdout ?? error.stdout);
    const meta = value.result?.meta;
    if (aborted) {
      // OpenClaw CLI returns a nonzero compact abort receipt, without agentMeta.
      assert.equal(value.summary, 'aborted');
      assert.equal(value.stopReason, 'rpc');
      const activity = (await readFile(path.join(root, 'studio/activity.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.ok(activity.some(event => event.kind === 'memory.recall' && event.runId === value.runId
        && event.sessionKey === run.sessionKey && event.loop === run.loop), 'Actual loop must have entered its prompt hook before cancellation');
    } else assert.equal(meta?.agentMeta?.agentHarnessId, run.loop, 'The selected loop must really execute');
    if (!aborted && run.probe.args?.id && await exists(path.join(control, `${run.probe.args.id}.started`))) {
      const admission = JSON.parse(await readFile(path.join(control, `${run.probe.args.id}.started`), 'utf8'));
      assert.equal(admission.subject, meta.agentMeta.sessionId, 'The worker call must retain the real host session identity');
    }
    if (!aborted) assert.ok(JSON.stringify(value).includes('COMPONENT_PROBE_OK'), JSON.stringify(value));
    checks.push({ loop: run.loop, runId: value.runId, probe: run.probe, aborted });
    return value;
  }
  const run = async (loop, probe) => finish(await start(loop, probe));
  const workerPid = (await manage('status')).pid;
  for (const loop of loops) {
    await run(loop, { capability: 'loop_probe', available: false });
    await run(loop, { capability: 'source_verify', args: { query: marker, quote } });
  }
  async function bundle(version) {
    const directory = path.join(root, `loop-probe-${version}`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'component.json'), JSON.stringify({
      id: 'loop-probe', version, description: 'Qualification-only gated dependent verifier', entry: './component.mjs',
      requires: { 'source-verifier': '^1.3.0' },
      capabilities: [{ name: 'loop_probe', description: 'Gated verifier for owned lifecycle qualification', permissions: ['workspace:read'],
        inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9-]+$' }, wait: { type: 'boolean' } }, required: ['id'], additionalProperties: false } }],
    }));
    // Control files are instrumentation belonging to this trusted test component,
    // outside the searchable workspace. They are not a shipped write capability.
    await writeFile(path.join(directory, 'component.mjs'), `
      import { readFile, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      const control = ${JSON.stringify(control)};
      export default { inject: ['bridgeCapabilities'], apply(ctx) {
        ctx.bridgeCapabilities.register(ctx, 'loop_probe', async (args, invocation) => {
          const file = control + '/' + args.id;
          await writeFile(file + '.started', JSON.stringify({ version: ${JSON.stringify(version)}, subject: invocation.subject, callId: invocation.callId }));
          try {
            while (args.wait) {
              invocation.signal.throwIfAborted();
              try { await readFile(file + '.release'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
              await delay(20, undefined, { signal: invocation.signal });
            }
            const value = await ctx.bridgeCapabilities.invoke('source_verify', ${JSON.stringify({ query: marker, quote })}, invocation);
            return { version: ${JSON.stringify(version)}, verified: value.verified };
          } catch (error) {
            if (invocation.signal.aborted) await writeFile(file + '.cancelled', String(invocation.signal.reason));
            throw error;
          } finally { await writeFile(file + '.finished', 'finished'); }
        });
      } };\n`);
    return path.join(directory, 'component.json');
  }
  await manage('components', 'install', await bundle('1.0.0'));
  const pending = [];
  for (const loop of loops) {
    const id = `upgrade-${loop}`;
    pending.push(await start(loop, { capability: 'loop_probe', args: { id, wait: true }, version: '1.0.0' }));
    await eventually(() => exists(path.join(control, `${id}.started`)), `${loop} admitted old version`);
    const admission = JSON.parse(await readFile(path.join(control, `${id}.started`), 'utf8'));
    assert.ok(admission.subject);
    assert.ok(admission.callId);
  }
  await manage('components', 'upgrade', 'loop-probe', await bundle('1.1.0'));
  assert.ok((await manage('status')).retiredGenerations > 0, 'Old graph must stay leased during upgrade');
  for (const loop of loops) await run(loop, { capability: 'loop_probe', args: { id: `new-${loop}` }, version: '1.1.0' });
  for (const loop of loops) await writeFile(path.join(control, `upgrade-${loop}.release`), 'release');
  for (const active of pending) await finish(active);
  await eventually(async () => (await manage('status')).retiredGenerations === 0, 'old generations released');

  // The real host abort RPC must cancel the actual worker handler, without restart.
  for (const loop of loops) {
    const id = `abort-${loop}`;
    const active = await start(loop, { capability: 'loop_probe', args: { id, wait: true }, version: '1.1.0' });
    await eventually(() => exists(path.join(control, `${id}.started`)), `${loop} cancellable handler started`);
    // A separate CLI connection does not own the agent CLI's run. This isolated
    // Gateway's generated operator token explicitly authorizes test cancellation.
    const aborted = await callGatewayFromCli('chat.abort', { url: gatewayUrl, token, timeout: '15000', json: true },
      { sessionKey: active.sessionKey }, { progress: false, scopes: ['operator.admin', 'operator.write'] });
    assert.equal(aborted.aborted, true);
    await eventually(() => exists(path.join(control, `${id}.cancelled`)), `${loop} worker received cancellation`);
    await finish(active, true);
    await eventually(async () => (await manage('status')).tasks === 0, `${loop} task resources released`);
  }

  const revoked = [];
  for (const loop of loops) {
    const id = `revoke-${loop}`;
    revoked.push(await start(loop, { capability: 'loop_probe', args: { id, wait: true }, error: 'POLICY_CHANGED|policy changed|cancel' }));
    await eventually(() => exists(path.join(control, `${id}.started`)), `${loop} handler started before revocation`);
  }
  const policyFile = path.join(root, 'dual-loop-policy.json');
  await writeFile(policyFile, JSON.stringify({ agents: { main: { deny: ['loop_probe'] } } }));
  await manage('policy', 'set', policyFile);
  for (const loop of loops) await eventually(() => exists(path.join(control, `revoke-${loop}.cancelled`)), `${loop} actual handler revoked`);
  for (const active of revoked) await finish(active);
  for (const loop of loops) await run(loop, { capability: 'loop_probe', available: false, invokeDenied: true,
    args: { id: `denied-${loop}` }, error: 'CAPABILITY_DENIED|policy.*denies' });
  for (const loop of loops) assert.equal(await exists(path.join(control, `denied-${loop}.started`)), false, 'Denied calls must not enter the component');
  await writeFile(policyFile, '{}');
  await manage('policy', 'set', policyFile);
  await manage('components', 'disable', 'loop-probe');
  for (const loop of loops) await run(loop, { capability: 'loop_probe', available: false });
  await manage('components', 'enable', 'loop-probe');
  for (const loop of loops) await run(loop, { capability: 'loop_probe', args: { id: `restored-${loop}` }, version: '1.1.0' });
  await manage('components', 'uninstall', 'loop-probe');
  for (const loop of loops) await run(loop, { capability: 'loop_probe', available: false });
  const status = await manage('status');
  assert.equal(status.pid, workerPid, 'Both loops use the same worker across management, cancellation and upgrades');
  assert.equal(status.tasks, 0);
  assert.equal(status.retiredGenerations, 0);
  return { sameWorker: true, actualLoopIdentityChecked: true, dynamicInstall: true, pinnedActiveVersions: true,
    nestedVerification: true, hostCancellation: true, liveRevocation: true, denialBeforeExecution: true, disableEnableUninstall: true, checks };
}
