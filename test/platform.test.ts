import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, writeFile, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertRuntime, assertPrivateFile, protectDirectory} from '../src/platform-support.mjs';
import {executionEnvironment} from '../src/environment.js';

test('platform admission accepts the RHEL 8 baseline and Windows x64 and rejects incompatible runtimes', () => {
  assert.doesNotThrow(() => assertRuntime('linux','x64','24.16.0','2.28'));
  assert.doesNotThrow(() => assertRuntime('win32','x64','24.16.0',undefined));
  for (const args of [['linux','x64','24.16.0','2.27'],['linux','x64','24.16.0',''],['linux','arm64','24.16.0','2.28'],['win32','x64','24.15.0',undefined],['win32','x64','22.23.1',undefined],['win32','x64','25.0.0',undefined]]) {
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
