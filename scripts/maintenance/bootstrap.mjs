#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, lstat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const lock = JSON.parse(await readFile(new URL('./sdk.lock.json', import.meta.url), 'utf8'));
const destination = path.join(root, '.vendor/dsh');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--archive')) throw Error('Usage: node scripts/maintenance/bootstrap.mjs [--archive /path/to/verified-sdk.tar.gz]');
async function validate(directory) {
  const metadata = await readFile(path.join(directory, 'sdk.json'));
  if (sha(metadata) !== lock.manifestSha256) throw Error('SDK manifest checksum mismatch');
  const meta = JSON.parse(metadata.toString('utf8'));
  const declared = new Set([...Object.keys(meta.files), 'sdk.json', '.archive-sha256']);
  for (const [name, hash] of Object.entries(meta.files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw Error('Unsafe SDK manifest path');
    const file = path.join(directory, name);
    if (!(await lstat(file)).isFile() || sha(await readFile(file)) !== hash) throw Error(`SDK file changed: ${name}`);
  }
  async function walk(base, relative = '') {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const name = relative + entry.name;
      if (entry.isSymbolicLink()) throw Error(`SDK contains an unexpected symlink: ${name}`);
      if (entry.isDirectory()) await walk(path.join(base, entry.name), name + '/');
      else if (!declared.has(name)) throw Error(`SDK contains an unexpected file: ${name}`);
    }
  }
  await walk(directory);
  for (const [name, spec] of Object.entries(lock.packages)) {
    const pkg = JSON.parse(await readFile(path.join(directory, spec.directory, 'package.json'), 'utf8'));
    if (pkg.name !== name || pkg.version !== spec.version) throw Error(`SDK package mismatch: ${name}`);
  }
}
try {
  if ((await readFile(path.join(destination, '.archive-sha256'), 'utf8')).trim() === lock.sha256) {
    await validate(destination); console.log(`Verified existing SDK: ${lock.packages ? Object.keys(lock.packages).length : 0} packages`); process.exit(0);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
// Never overwrite an unrecognized local SDK or mix revisions.
try { await lstat(destination); throw Error('Existing .vendor/dsh is not this pinned SDK; move it aside before bootstrapping.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(destination), { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'conest-sdk-'));
const stage = path.join(path.dirname(destination), `.dsh-${randomUUID()}`);
try {
  let bytes;
  if (args.length) bytes = await readFile(path.resolve(args[1]));
  else {
    console.log(`Downloading pinned SDK: ${lock.release}`);
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`SDK download failed: HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > lock.maxBytes) throw Error('SDK download exceeds its size limit');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (bytes.length > lock.maxBytes || sha(bytes) !== lock.sha256) throw Error('SDK SHA256 mismatch; nothing installed');
  const archive = path.join(temporary, 'sdk.tar.gz'); await writeFile(archive, bytes);
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4_000_000 });
  if (listing.error || listing.status !== 0) throw Error('A working tar executable is required to extract the SDK');
  for (const name of listing.stdout.trim().split('\n')) if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw Error('Unsafe SDK archive member');
  await mkdir(stage);
  const unpack = spawnSync('tar', ['-xzf', archive, '-C', stage], { encoding: 'utf8' });
  if (unpack.error || unpack.status !== 0) throw Error(`SDK extraction failed: ${unpack.stderr}`);
  await validate(stage);
  await writeFile(path.join(stage, '.archive-sha256'), lock.sha256 + '\n');
  await rename(stage, destination);
  console.log(`SDK ready: ${Object.keys(lock.packages).length} source/runtime packages; no OS dependencies installed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
}
