import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { supportedTargets } from '../src/platform-support.mjs';

const args = process.argv.slice(2), flags = {};
while (args.length) {
  const key = args.shift(), value = args.shift();
  assert(['--archive', '--target', '--out'].includes(key) && value && !flags[key], 'Usage: pack-unix.mjs --archive FILE.tgz --target TARGET --out DIR');
  flags[key] = value;
}
const target = flags['--target'];
assert(supportedTargets.includes(target) && !target.startsWith('win32-'), 'Choose linux-x64, darwin-x64 or darwin-arm64');
assert(flags['--archive'] && flags['--out'], 'Supply --archive and --out');
const archive = path.resolve(flags['--archive']);
const expected = (await readFile(archive + '.sha256', 'utf8')).trim().split(/\s+/)[0];
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expected, 'Plugin archive checksum mismatch');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/runtime-lock.json'], { encoding: 'utf8' }));
assert.equal(`${lock.platform}-${lock.arch}`, target, 'Plugin archive does not match the installer target');
assert.equal(lock.bridgeVersion, version, 'Plugin archive version does not match the installer');
await mkdir(path.resolve(flags['--out']), { recursive: true });
const bundle = path.resolve(flags['--out'], `conest-${version}-${target}`);
await mkdir(bundle, { recursive: false });
const packages = path.join(bundle, 'packages', target);
await mkdir(packages, { recursive: true });
const archiveName = `local-conest-connector-${version}.tgz`;
await cp(archive, path.join(packages, archiveName));
await writeFile(path.join(packages, archiveName + '.sha256'), `${expected}  ${archiveName}\n`);
for (const file of ['install.sh', 'setup.mjs', 'launch.mjs']) await cp(new URL(`./platform/${file}`, import.meta.url), path.join(bundle, file));
await writeFile(path.join(bundle, 'delivery.json'), JSON.stringify({ version, target }, null, 2) + '\n');
console.log(bundle);
