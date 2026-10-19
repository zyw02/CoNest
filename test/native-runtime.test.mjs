import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Also exercise bindings from an archive installed without lifecycle scripts.
const require = createRequire(process.env.CONEST_NATIVE_ROOT
  ? path.join(process.env.CONEST_NATIVE_ROOT, 'package.json') : import.meta.url);
const execute = promisify(execFile);

test('native PTY runs a real shell through the packaged spawn helper', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf CONEST_PTY_OK'], { env: { PATH: process.env.PATH }, cols: 80, rows: 24 });
  t.after(() => { try { pty.kill(); } catch {} });
  let output = '';
  const result = await new Promise(resolve => {
    pty.onData(data => { output += data; });
    pty.onExit(resolve);
  });
  assert.equal(result.exitCode, 0);
  assert.match(output, /CONEST_PTY_OK/);
});

test('native flock rejects a second owner and releases the file on close', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conest-flock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { tryLockExclusive } = await import(pathToFileURL(require.resolve('@deepseek-ai/node-addon-system/flock')).href);
  const first = await open(path.join(root, 'lock'), 'w');
  const second = await open(path.join(root, 'lock'), 'r+');
  try {
    await tryLockExclusive(first.fd);
    await assert.rejects(tryLockExclusive(second.fd), error => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code));
    await first.close();
    await tryLockExclusive(second.fd);
  } finally { await first.close(); await second.close(); }
});

test('native sharp encodes an image and koffi calls the current process', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#336699' } }).png().toBuffer();
  assert.equal((await sharp(png).metadata()).height, 3);
  const koffi = require('koffi');
  const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null);
  const pid = library.func(process.platform === 'win32' ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()');
  assert.equal(pid(), process.pid);
});

test('packaged ripgrep executes on the current operating system', async () => {
  const { rgPath } = await import(pathToFileURL(require.resolve('@vscode/ripgrep')).href);
  assert.match((await execute(rgPath, ['--version'])).stdout, /^ripgrep /);
});
