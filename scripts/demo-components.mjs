#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.argv.indexOf('--out');
const reportFile = output >= 0 ? path.resolve(process.argv[output + 1]) : undefined;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'conest-components-'));
const workspace = path.join(temporary, 'workspace');
await mkdir(workspace);
await cp(path.join(root, 'examples/office'), path.join(temporary, 'office'), { recursive: true });
const configFile = path.join(temporary, 'conest.json');
await writeFile(configFile, JSON.stringify({ workspaceRoot: workspace,
  builtins: Object.fromEntries(['dsh-search', 'dsh-read', 'dsh-memory', 'result-verifier'].map(id => [id, { enabled: false }])),
  components: ['office-knowledge', 'office-check', 'office-context'].map(id => ({ manifest: path.join(temporary, 'office', id, 'component.json') })),
}));
// Reject DSH imports rather than relying on a disabled UI or a successful build.
const worker = path.join(temporary, 'core-worker.mjs');
await writeFile(worker, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (/(@deepseek-ai\\/dsh-|studio\\/host-runtime|dsh-search-component|memory-component|read-component)/.test(specifier)) throw new Error('DSH dependency forbidden: '+specifier);
  return next(specifier, context);
}});
await import(${JSON.stringify(pathToFileURL(path.join(root, 'dist/worker.js')).href)});
`);
const { BridgeClient } = await import(pathToFileURL(path.join(root, 'dist/client.js')).href);
const client = new BridgeClient({ workerFile: worker, configFile, startupTimeoutMs: process.platform === 'win32' ? 60_000 : 20_000, shutdownTimeoutMs: 5_000, onLog: (level, message) => console.error(`[CoNest Host ${level}] ${message}`) });
const checks = [];
const check = (name, evidence) => { checks.push({ name, passed: true, evidence }); console.log('PASS '+name); };
let count = 0;
const invoke = (args, onProgress) => client.invoke({ capability: 'office_check', args,
  taskId: `task-${++count}`, callId: `call-${count}`, subject: 'demo', principal: { kind: 'agent', agentId: 'main' },
  workspaceRoot: workspace, permissions: ['workspace:read'], onProgress });
try {
  const initial = await client.start();
  assert.equal(initial.state, 'ready');
  check('Core operates with DSH module loading forbidden', { pid: initial.pid });
  const entered = Promise.withResolvers();
  const oldCall = invoke({ attachment: false, delayMs: 1200 }, progress => { if (progress.message.includes('admitted')) entered.resolve(); });
  await entered.promise;
  await client.manage({ action: 'configure', id: 'office-knowledge', config: { source: 'Customer B', revision: 'B-2', requiredAttachment: false } });
  const next = await invoke({ attachment: false });
  const previous = await oldCall;
  assert.equal(previous.value.policy.revision, 'A-1'); assert.equal(previous.value.passed, false);
  assert.equal(next.value.policy.revision, 'B-2'); assert.equal(next.value.passed, true);
  assert.equal(previous.value.consistent, true); assert.notEqual(previous.generation, next.generation);
  check('Admitted call retains its dependency graph while new calls use the replacement', { previous, next });
  check('Customer backend configuration changes without changing the consumer component', { source: next.value.policy.source });
  const beforeFailure = (await client.status()).revision;
  await assert.rejects(client.manage({ action: 'configure', id: 'office-knowledge', config: { invalid: true } }));
  assert.equal((await client.status()).revision, beforeFailure);
  check('Failed candidate preserves the accepted graph', { revision: beforeFailure });
  const disabled = await client.manage({ action: 'disable', id: 'office-knowledge' });
  assert.equal(disabled.components.find(c => c.id === 'office-check').state, 'blocked');
  await assert.rejects(invoke({ attachment: true }));
  await client.manage({ action: 'enable', id: 'office-knowledge' });
  assert.equal((await invoke({ attachment: true })).value.passed, true);
  check('Dependency removal blocks its consumers; restoration makes them usable again', {});
  const report = { version: '0.6.4', platform: process.platform, arch: process.arch, noDshImports: true, modelCalls: 0, checks };
  if (reportFile) { await mkdir(path.dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2)+'\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally { await client.stop(); await rm(temporary, { recursive: true, force: true }); }
