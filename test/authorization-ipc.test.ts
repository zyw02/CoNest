import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { BridgeClient } from '../src/client.js';

async function fixture(t: test.TestContext, holdCleanupReply = false) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'conest-auth-real-'));
  const gate = path.join(workspace, 'release-reply');
  const worker = path.join(workspace, 'proxy.mjs');
  const actualWorker = path.resolve('dist/worker.js');
  await writeFile(path.join(workspace, 'source.txt'), 'authorization cleanup marker\n');
  await writeFile(worker, `
    import { spawn } from 'node:child_process';
    import { createInterface } from 'node:readline';
    import { existsSync } from 'node:fs';
    const child = spawn(process.execPath, [${JSON.stringify(actualWorker)}, ...process.argv.slice(2)], {stdio: ['pipe','pipe','pipe']});
    const methods = new Map(); const held = []; let open = false;
    createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (existsSync(${JSON.stringify(gate)})) {
        open = true;
        for (const frame of held.splice(0)) process.stdout.write(frame + '\\n');
      }
      methods.set(request.id, request.method);
      child.stdin.write(line + '\\n');
    });
    createInterface({input:child.stdout}).on('line', line => {
      const reply = JSON.parse(line); const method = methods.get(reply.id); methods.delete(reply.id);
      if (method === 'release' && ${holdCleanupReply}) {
        process.stderr.write('CLEANUP_REPLY_HELD\\n');
      } else if (method === 'authorize' && reply.ok && !open) {
        held.push(line); process.stderr.write('AUTHORIZATION_HELD\\n');
      } else {
        process.stdout.write(line + '\\n');
        if (reply.ok && reply.result?.released === true) process.stderr.write('GRANT_RELEASED\\n');
      }
    });
    child.stderr.pipe(process.stderr);
    child.on('exit', code => process.exit(code ?? 1));
    process.stdin.on('end', () => child.stdin.end());
  `);
  const held = Promise.withResolvers<void>();
  const cleanupHeld = Promise.withResolvers<void>();
  const client = new BridgeClient({ workerFile: worker, workspaceRoot: workspace,
    startupTimeoutMs: 15_000, shutdownTimeoutMs: 1_000,
    onLog: (_level, message) => {
      if (message === 'AUTHORIZATION_HELD') held.resolve();
      if (message === 'CLEANUP_REPLY_HELD') cleanupHeld.resolve();
    },
  });
  t.after(async () => { t.mock.timers.reset(); await client.stop(); await rm(workspace, {recursive:true,force:true}); });
  await client.start();
  return {client, held:held.promise, cleanupHeld:cleanupHeld.promise, gate, input: {
    capability:'knowledge_search', args:{query:'authorization cleanup marker'}, taskId:'same-task', callId:'first-call',
    subject:'test', principal:{kind:'agent' as const,agentId:'main'}, workspaceRoot:workspace,
    permissions:['workspace:read' as const],
  }};
}

test('real worker releases authorization after cancellation before allowing same-task retry', async t => {
  const {client,held,gate,input} = await fixture(t);
  const abort = new AbortController();
  const invocation = client.invoke({...input,signal:abort.signal});
  void invocation.catch(() => {});
  await held;
  assert.equal((await client.status()).grants, 1);
  abort.abort(new Error('caller cancelled'));
  assert.equal((await client.status()).grants, 0, 'cancellation must release the real reservation');
  await assert.rejects(invocation, /caller cancelled/);
  await writeFile(gate,'open');
  await client.status();
  const result = await client.invoke({...input,callId:'retry-call'});
  assert.equal((result.value as {totalMatches:number}).totalMatches, 1);
});

test('real worker accepts same-task retry after a timed-out authorization reply arrives late', async t => {
  const {client,held,gate,input} = await fixture(t);
  t.mock.timers.enable({apis:['setTimeout']});
  const invocation = client.invoke(input);
  const rejection = assert.rejects(invocation,{code:'BRIDGE_TIMEOUT'});
  await held;
  assert.equal((await client.status()).grants, 1);
  t.mock.timers.tick(10_001);
  await rejection;
  assert.equal((await client.status()).grants, 0, 'timeout must release the reservation before its reply arrives');
  await writeFile(gate,'open');
  await client.status();
  assert.equal((await client.status()).grants, 0);
  assert.equal((await client.invoke({...input,callId:'retry-call'})).value !== undefined,true);
});

test('unconfirmed authorization cleanup stops the owned worker before allowing another call', async t => {
  const {client,held,cleanupHeld,input} = await fixture(t, true);
  const abort = new AbortController();
  const invocation = client.invoke({...input,signal:abort.signal});
  const rejection = assert.rejects(invocation,{code:'BRIDGE_TIMEOUT'});
  await held;
  t.mock.timers.enable({apis:['setTimeout']});
  abort.abort(new Error('caller cancelled'));
  await cleanupHeld;
  t.mock.timers.tick(1_001);
  await rejection;
  assert.equal(client.getState().state,'stopped');
  await assert.rejects(client.invoke({...input,callId:'retry-call'}),{code:'BRIDGE_UNAVAILABLE'});
});
