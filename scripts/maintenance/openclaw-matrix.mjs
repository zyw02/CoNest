import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// OpenClaw also publishes numeric repacks such as 2026.7.1-2 on its stable
// channel. SemVer calls these prereleases; the release matrix must retain them.
function release(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(version);
  return match ? match.slice(1).map(value => Number(value ?? 0)) : undefined;
}
function compare(a, b) {
  const left = release(a), right = release(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
export function resolveOpenClawMatrix(metadata, minimum) {
  const latest = metadata['dist-tags']?.latest;
  const versions = Array.isArray(metadata.versions) ? metadata.versions : Object.keys(metadata.versions ?? {});
  if (!release(minimum) || !release(latest ?? '') || compare(latest, minimum) < 0) {
    throw new Error('OpenClaw latest must be a stable release at or above the matrix floor');
  }
  if (!versions.includes(minimum) || !versions.includes(latest)) throw new Error('Registry omitted the floor or latest release');
  const selected = [...new Set(versions.filter(version => release(version)
    && compare(version, minimum) >= 0 && compare(version, latest) <= 0))].sort(compare);
  if (selected.length > 128) throw new Error('OpenClaw matrix exceeds the GitHub job limit; shard it without dropping releases');
  return selected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policy = JSON.parse(await readFile(new URL('../../compatibility.json', import.meta.url), 'utf8'));
  const response = await fetch('https://registry.npmjs.org/openclaw', {
    headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenClaw registry returned HTTP ${response.status}`);
  const versions = resolveOpenClawMatrix(await response.json(), policy.adapters.openclaw.minimum);
  process.stdout.write(`${JSON.stringify(versions)}\n`);
}
