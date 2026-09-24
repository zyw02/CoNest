#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_SOURCE_PREFIX = 'file:.vendor/dsh/';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

export async function selectDshPackages(manifest, version, revision, loadManifest, requiredNames) {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid DSH version: ${version}`);
  if (!REVISION_PATTERN.test(revision)) throw new Error(`DSH revision must be a full commit SHA: ${revision}`);
  const selected = [];
  const output = structuredClone(manifest);
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, specifier] of Object.entries(output[group] ?? {})) {
      if (typeof specifier !== 'string' || !specifier.startsWith(DSH_SOURCE_PREFIX)) continue;
      if (!requiredNames.has(name)) {
        delete output[group][name];
        continue;
      }
      const relative = specifier.slice(DSH_SOURCE_PREFIX.length);
      let selectedVersion = version;
      if (!name.startsWith('@deepseek-ai/dsh-')) {
        const upstream = await loadManifest(relative);
        if (upstream.name !== name) throw new Error(`DSH package identity mismatch at ${relative}: expected ${name}, received ${upstream.name}`);
        if (!VERSION_PATTERN.test(upstream.version)) throw new Error(`DSH package did not publish a semantic version: ${name}`);
        selectedVersion = upstream.version;
      }
      output[group][name] = selectedVersion;
      selected.push({ group, name, version: selectedVersion, source: relative });
    }
  }
  if (!selected.some(entry => entry.name === '@deepseek-ai/dsh-agent')) throw new Error('No DSH adapter packages were selected');
  return { manifest: output, selected };
}

export function selectDshWorkspace(source, publicOverrides = {}) {
  const lines = source.split('\n');
  const output = [];
  let skipOverrides = false;
  for (const line of lines) {
    if (line === 'overrides:') {
      skipOverrides = true;
      continue;
    }
    if (skipOverrides) {
      if (line.startsWith('  ') || line === '') continue;
      skipOverrides = false;
    }
    if (line === 'autoInstallPeers: false') output.push('autoInstallPeers: true');
    else if (/^  "@deepseek-ai\/dsh-subprocess-local@file:/.test(line)) output.push('  "@deepseek-ai/dsh-subprocess-local": true');
    else output.push(line);
  }
  const rendered = output.join('\n').trimEnd();
  const overrides = Object.entries(publicOverrides);
  if (!overrides.length) return rendered + '\n';
  return `${rendered}\n\noverrides:\n${overrides.map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join('\n')}\n`;
}

async function discoverDirectPackages(root) {
  const names = new Set();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:[cm]?[jt]s)$/.test(entry.name)) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(/@deepseek-ai\/[a-z0-9][a-z0-9-]*/g)) names.add(match[0]);
      }
    }
  }
  for (const directory of ['src', 'scripts', 'test']) await visit(path.join(root, directory));
  return names;
}

async function main() {
  const [version, revision] = process.argv.slice(2);
  if (!version || !revision) throw new Error('Usage: node scripts/maintenance/select-dsh-version.mjs <version> <commit-sha>');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const packageFile = path.join(root, 'package.json');
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  const compatibilityFile = path.join(root, 'compatibility.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  const compatibility = JSON.parse(await readFile(compatibilityFile, 'utf8'));
  const qualification = compatibility.adapters?.dsh?.qualifications?.find(
    entry => entry.version === version && entry.revision === revision,
  );
  const loadManifest = async relative => {
    const url = `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${revision}/${relative}/package.json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Unable to read DSH package metadata at ${relative}: HTTP ${response.status}`);
    return response.json();
  };
  const releaseResponse = await fetch(`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${revision}/package.json`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!releaseResponse.ok) throw new Error(`Unable to read DSH release metadata: HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  if (release.name !== '@deepseek-ai/dsh-root' || release.version !== version) {
    throw new Error(`DSH revision ${revision} identifies ${release.name}@${release.version}, expected @deepseek-ai/dsh-root@${version}`);
  }
  const requiredNames = await discoverDirectPackages(root);
  const result = await selectDshPackages(manifest, version, revision, loadManifest, requiredNames);
  await writeFile(packageFile, JSON.stringify(result.manifest, null, 2) + '\n');
  await writeFile(workspaceFile, selectDshWorkspace(
    await readFile(workspaceFile, 'utf8'),
    qualification?.workspaceOverrides ?? {},
  ));
  console.log(`Selected DSH ${version} from ${revision}: ${result.selected.length} direct packages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
