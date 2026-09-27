import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const version = process.argv[2];
if (process.argv.length !== 3 || !/^\d+\.\d+\.\d+(?:-\d+)?$/.test(version ?? '')) {
  throw new Error('Usage: node scripts/maintenance/select-openclaw-version.mjs STABLE_VERSION');
}
// Numeric host repacks reuse the provider release with the same base version.
const providerVersion = version.replace(/-\d+$/, '');
const manifest = new URL('../../package.json', import.meta.url);
const lock = new URL('../../pnpm-lock.yaml', import.meta.url);
const original = readFileSync(manifest);
const originalLock = readFileSync(lock);
try {
  // The package is compiled against the frozen SDK before selecting the runtime
  // host. Installing a host must not rewrite release pins or qualification data.
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  execFileSync(pnpm, ['add', '--save-dev', '--ignore-workspace-root-check', '--lockfile=false', `openclaw@${version}`, `@openclaw/deepseek-provider@${providerVersion}`],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const installed = JSON.parse(readFileSync(path.resolve(path.dirname(require.resolve('openclaw/plugin-sdk/plugin-entry')), '../../package.json'), 'utf8')).version;
  const provider = JSON.parse(readFileSync(new URL('../../node_modules/@openclaw/deepseek-provider/package.json', import.meta.url), 'utf8')).version;
  if (provider !== providerVersion) throw new Error(`Requested DeepSeek provider ${providerVersion}, installed ${provider}`);
  if (installed !== version) throw new Error(`Requested OpenClaw ${version}, installed ${installed}`);
  if (!readFileSync(lock).equals(originalLock)) throw new Error('Host selection changed the frozen lockfile');
} finally {
  writeFileSync(manifest, original);
}
