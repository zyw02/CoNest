import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { BridgeClient } from '../src/client.js';
import { BridgeHost } from '../src/host.js';
import { controlRequest } from '../src/control.js';
import { component, eventually, fixture, hasCode, request } from './helpers.js';

const workerFile = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const cliFile = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const execute = promisify(execFile);

test('a killed worker rejects interrupted work, does not replay it, and recovers on the next request', async context => {
  const { root, workspace, configFile } = await fixture(context);
  const ledger = path.join(root, 'calls.txt');
  const manifest = await processFixture(root, ledger);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [manifest] }));
  const host = new BridgeHost({ workerFile, configFile, startupTimeoutMs: 5_000, shutdownTimeoutMs: 200 });
  try {
    const started = await host.start();
    const active = host.invoke({ ...request(workspace, 'process_work', { mode: 'slow' }) });
    const failed = assert.rejects(active, hasCode('BRIDGE_EXITED'));
    await eventually(async () => (await readFile(ledger, 'utf8').catch(() => '')).includes('slow'));
    process.kill(started.pid, 'SIGKILL');
    await failed;
    assert.equal((await readFile(ledger, 'utf8')).trim(), 'slow');
    const recovered = await host.refresh();
    assert.notEqual(recovered.pid, started.pid);
    const result = await host.invoke(request(workspace, 'process_work', { mode: 'fast' }));
    assert.equal(result.value, 'completed');
    assert.deepEqual((await readFile(ledger, 'utf8')).trim().split('\n'), ['slow', 'fast']);
    await host.stop();
    assert.throws(() => process.kill(recovered.pid, 0), { code: 'ESRCH' });
  } finally { await host.stop(); }
});

test('an uncooperative task triggers worker termination after TTL and its abort grace period', async context => {
  const { root, workspace, configFile } = await fixture(context);
  const manifest = await processFixture(root, path.join(root, 'calls.txt'));
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [manifest], taskTtlMs: 100, abortGraceMs: 100 }));
  const client = new BridgeClient({ workerFile, configFile, startupTimeoutMs: 5_000, shutdownTimeoutMs: 200 });
  try {
    const started = await client.start();
    await assert.rejects(client.invoke(request(workspace, 'process_work', { mode: 'ignore' })), hasCode('BRIDGE_EXITED'));
    assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  } finally { await client.stop(); }
});

test('supervisor shutdown reaps a worker whose event loop cannot process SIGTERM', async context => {
  const { root, workspace, configFile } = await fixture(context);
  const ledger = path.join(root, 'calls.txt');
  const manifest = await processFixture(root, ledger);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [manifest] }));
  const client = new BridgeClient({ workerFile, configFile, startupTimeoutMs: 5_000, shutdownTimeoutMs: 100 });
  try {
    const started = await client.start();
    const active = client.invoke(request(workspace, 'process_work', { mode: 'busy' }));
    const failed = assert.rejects(active, hasCode('BRIDGE_EXITED'));
    await eventually(async () => (await readFile(ledger, 'utf8').catch(() => '')).includes('busy'));
    await client.stop();
    await failed;
    assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  } finally { await client.stop(); }
});

test('CLI management and generic calls use the running worker, and a second owner is rejected', async context => {
  const { workspace, configFile } = await fixture(context);
  await writeFile(path.join(workspace, 'source.txt'), 'Live worker source marker\n');
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [] }));
  const options = { workerFile, configFile, startupTimeoutMs: 5_000, shutdownTimeoutMs: 200 };
  const client = new BridgeClient(options);
  const duplicate = new BridgeClient(options);
  try {
    const started = await client.start();
    await assert.rejects(duplicate.start(), hasCode('BRIDGE_EXITED'));
    const example = fileURLToPath(new URL('../examples/source-verifier/component.json', import.meta.url));
    const installed = await execute(process.execPath, [cliFile, 'components', 'install', example, '--config', configFile, '--json']);
    assert.equal(JSON.parse(installed.stdout).pid, started.pid);
    assert.ok((await client.status()).capabilities.some(capability => capability.name === 'source_verify'));
    const called = await execute(process.execPath, [cliFile, 'invoke', 'source_verify', JSON.stringify({ query: 'marker', quote: 'Live worker source marker' }), '--config', configFile, '--json']);
    assert.equal(JSON.parse(called.stdout).value.verified, true);
    await execute(process.execPath, [cliFile, 'components', 'uninstall', 'source-verifier', '--config', configFile, '--json']);
    assert.equal((await client.status()).capabilities.some(capability => capability.name === 'source_verify'), false);
    assert.equal((await controlRequest(configFile, 'status'))?.pid, started.pid);
    await assert.rejects(controlRequest(configFile, 'call', { capability: 'knowledge_search', args: { query: 'marker' }, principal: { kind: 'agent', agentId: 'privileged' } }), hasCode('INVALID_REQUEST'));
    const acceptedConfig = await readFile(configFile, 'utf8');
    await writeFile(configFile, '{ invalid configuration');
    const stillObservable = await execute(process.execPath, [cliFile, 'status', '--config', configFile, '--json']);
    assert.equal(JSON.parse(stillObservable.stdout).pid, started.pid);
    await assert.rejects(execute(process.execPath, [cliFile, 'reload', '--config', configFile, '--json']));
    await writeFile(configFile, acceptedConfig);
  } finally { await duplicate.stop(); await client.stop(); }
});

test('policy revocation contains uncooperative active work at the process boundary', async context => {
  const { root, workspace, configFile } = await fixture(context);
  const ledger = path.join(root, 'policy-work.txt');
  const manifest = await processFixture(root, ledger);
  await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace, components: [manifest], taskTtlMs: 10_000, abortGraceMs: 100 }));
  const client = new BridgeClient({ workerFile, configFile, startupTimeoutMs: 5000, shutdownTimeoutMs: 200 });
  try {
    const started = await client.start();
    const failed = assert.rejects(client.invoke(request(workspace, 'process_work', { mode: 'ignore' })), hasCode('BRIDGE_EXITED'));
    await eventually(async () => (await readFile(ledger, 'utf8').catch(() => '')).includes('ignore'));
    await client.manage({ action: 'policy', policy: { defaults: { deny: ['process_work'] } } });
    await failed;
    assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
    assert.equal((await readFile(ledger, 'utf8')).trim(), 'ignore');
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')).capabilityPolicy.defaults.deny, ['process_work']);
  } finally { await client.stop(); }
});

test('stdin EOF shuts down the worker and oversized partial frames cannot accumulate indefinitely', async context => {
  const { workspace } = await fixture(context);
  for (const oversized of [false, true]) {
    const child = spawn(process.execPath, [workerFile, 'serve', '--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', error => {
      if (!oversized || (error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
    });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    try {
      const ready = new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
      child.stdin.write(`${JSON.stringify({ id: 'status', method: 'status' })}\n`);
      await ready;
      if (oversized) child.stdin.write(Buffer.alloc(300_000, 65));
      else child.stdin.end();
      const deadline = setTimeout(() => child.kill('SIGKILL'), 3_000);
      try { assert.equal(await exited, 0); } finally { clearTimeout(deadline); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  }
});

test('the worker reports a dropped response when its stdout is already destroyed', async context => {
  const { workspace } = await fixture(context);
  const script = `const { PassThrough } = await import('node:stream');
    process.argv = [process.execPath, ${JSON.stringify(workerFile)}, 'serve', '--workspace', ${JSON.stringify(workspace)}];
    Object.defineProperty(process, 'stdout', { configurable: true, value: new PassThrough() });
    process.stdout.destroy();
    if (!process.stdout.destroyed) throw new Error('The stdout fixture did not enter its destroyed state');
    await import(${JSON.stringify(pathToFileURL(workerFile).href)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  try {
    await eventually(() => errors.includes('CoNest Host startup: ready'), 5_000);
    child.stdin.write(`${JSON.stringify({ id: 'probe', method: 'status' })}\n`);
    await eventually(() => errors.includes('CoNest Runtime send: stdout already destroyed; dropped probe'), 3_000);
    child.stdin.end();
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
});

async function processFixture(root: string, ledger: string): Promise<string> {
  return await component(root, {
    id: 'process-fixture', version: '1.0.0', description: 'Process lifecycle fixture', entry: '', requires: {},
    capabilities: [{ name: 'process_work', description: 'Run bounded test work', permissions: ['workspace:read'], inputSchema: {
      type: 'object', properties: { mode: { enum: ['slow', 'fast', 'ignore', 'busy'] } }, required: ['mode'], additionalProperties: false,
    } }],
  }, `import { appendFileSync } from 'node:fs';
  export default {
    inject: ['bridgeCapabilities'],
    apply(ctx) {
      ctx.bridgeCapabilities.register(ctx, 'process_work', async (args, invocation) => {
        appendFileSync(${JSON.stringify(ledger)}, args.mode + '\\n');
        if (args.mode === 'busy') { while (true) {} }
        if (args.mode === 'ignore') return await new Promise(() => {});
        if (args.mode === 'slow') await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 10000);
          invocation.signal.addEventListener('abort', () => { clearTimeout(timer); reject(invocation.signal.reason); }, { once: true });
        });
        return 'completed';
      });
    },
  };`);
}
