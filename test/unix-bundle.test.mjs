import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const builder = fileURLToPath(new URL('../scripts/pack-unix.mjs', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conest-unix-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = path.join(root, 'contents');
  await mkdir(path.join(contents, 'package'), { recursive: true });
  await writeFile(path.join(contents, 'package/runtime-lock.json'), JSON.stringify({ bridgeVersion: version, platform: 'darwin', arch: 'arm64' }));
  const archive = path.join(root, 'renamed-candidate.tgz');
  await execute('tar', ['-czf', archive, '-C', contents, 'package']);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(archive + '.sha256', `${hash}  renamed-candidate.tgz\n`);
  const output = path.join(root, 'delivery');
  return { archive, hash, output, bundle: path.join(output, `conest-${version}-darwin-arm64`) };
}

test('Unix bundle accepts a renamed archive and publishes the exact setup filename and checksum', async t => {
  const f = await fixture(t);
  await execute(process.execPath, [builder, '--archive', f.archive, '--target', 'darwin-arm64', '--out', f.output]);
  const name = `local-conest-connector-${version}.tgz`;
  const packaged = path.join(f.bundle, 'packages/darwin-arm64', name);
  assert.equal(createHash('sha256').update(await readFile(packaged)).digest('hex'), f.hash);
  assert.equal(await readFile(packaged + '.sha256', 'utf8'), `${f.hash}  ${name}\n`);
  for (const file of ['install.sh', 'setup.mjs', 'launch.mjs']) await access(path.join(f.bundle, file));
});

test('Unix bundle rejects a mismatched target before creating a delivery directory', async t => {
  const f = await fixture(t);
  await assert.rejects(execute(process.execPath, [builder, '--archive', f.archive, '--target', 'darwin-x64', '--out', f.output]), error => /does not match the installer target/.test(error.stderr));
  await assert.rejects(access(f.output), { code: 'ENOENT' });
});
