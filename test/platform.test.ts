import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, writeFile, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertRuntime, assertPrivateFile, assertPrivateDirectory, protectDirectory} from '../src/platform-support.mjs';
import { setTestPermissions } from './file-permissions.js';
import {executionEnvironment} from '../src/environment.js';
import {controlAddress, controlRequest, serveControl} from '../src/control.js';

test('platform admission accepts Linux/Windows x64 and both macOS architectures and rejects incompatible runtimes', () => {
  assert.doesNotThrow(() => assertRuntime('linux','x64','24.16.0','2.28'));
  assert.doesNotThrow(() => assertRuntime('win32','x64','24.16.0',undefined));
  for (const arch of ['x64','arm64']) assert.doesNotThrow(() => assertRuntime('darwin',arch,'24.16.0',''));
  for (const args of [['darwin','ia32','24.16.0',''],['darwin','arm64','24.15.0',''],['darwin','arm64','25.0.0',''],['freebsd','x64','24.16.0',''],['linux','x64','24.16.0','2.27'],['linux','x64','24.16.0',''],['linux','arm64','24.16.0','2.28'],['win32','arm64','24.16.0',''],['win32','x64','24.15.0',undefined],['win32','x64','22.23.1',undefined],['win32','x64','25.0.0',undefined]]) {
    assert.throws(() => assertRuntime(...args));
  }
});
test('component execution retains Windows OS paths with original casing while removing model secrets', () => {
  const env=executionEnvironment({Path:'C:\\Windows\\System32',SYSTEMROOT:'C:\\Windows',USERPROFILE:'C:\\Users\\Example',LOCALAPPDATA:'C:\\Users\\Example\\AppData\\Local',DEEPSEEK_API_KEY:'must-not-pass',OPENCLAW_GATEWAY_TOKEN:'must-not-pass'});
  assert.equal(env.Path,'C:\\Windows\\System32');assert.equal(env.SYSTEMROOT,'C:\\Windows');assert.equal(env.USERPROFILE,'C:\\Users\\Example');assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(env.OPENCLAW_GATEWAY_TOKEN,undefined);
});
test('private credentials remain protected and indirect credential files are rejected', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'conest-private-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'private');await protectDirectory(dir);const file=path.join(dir,'key.env');await writeFile(file,'DEEPSEEK_API_KEY=synthetic-test-only\n',{mode:0o600});await assertPrivateFile(file);
  // Windows symlink creation depends on host privileges; the native CI still verifies ACLs above.
  if(process.platform!=='win32'){const link=path.join(dir,'linked.env');await symlink(file,link);await assert.rejects(assertPrivateFile(link),/regular file/);}
});


test('private state rejects broadened directory and file permissions on the executing platform', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conest-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'state');
  await protectDirectory(directory);
  const file = path.join(directory, 'credentials.env');
  await writeFile(file, 'synthetic fixture', { mode: 0o600 });
  await assertPrivateDirectory(directory);
  await assertPrivateFile(file);
  await setTestPermissions(directory, 0o755);
  await assert.rejects(assertPrivateDirectory(directory));
  await setTestPermissions(directory, 0o700);
  await assertPrivateDirectory(directory);
  await setTestPermissions(file, 0o644);
  await assert.rejects(assertPrivateFile(file), /owner-only/);
});

test('local control works with macOS-style long temporary paths', { skip: process.platform !== 'darwin' }, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'conest-control-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=path.join(root,'config.json');await writeFile(config,'{}');
  const previous=process.env.TMPDIR;process.env.TMPDIR=path.join(root,'long-temporary-directory-'.repeat(6));
  try {
    assert(Buffer.byteLength(controlAddress(config))<104);
    const close=await serveControl(config,async()=>({pid:process.pid}));
    try { assert.equal((await controlRequest(config,'status'))?.pid,process.pid); }
    finally { await close(); }
  } finally { if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous; }
});
