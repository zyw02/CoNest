import { createRequire } from 'node:module';
import semver from 'semver';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** Public package metadata only; safe for CLI and worker imports. */
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(require.resolve('openclaw/plugin-sdk/plugin-entry')), '../..');
export const openClawVersion: string = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// The September 2 SDK introduced the scoped V2 harness and finalized prompt
// authority used by this connector. Earlier release lines keep the V1 contract.
// Every stable release in both intervals is exercised by the runtime matrix.
export const openClawContract = semver.gte(openClawVersion, '2026.9.2') ? 'scoped-v2' : 'legacy-v1';

/** Serialize generated agent configuration using the host's public schema. */
export function createHostAgentsConfig<T extends object, E extends object>(agents: {
  defaults: T; entries: Record<string, E>;
}) {
  if (semver.lt(openClawVersion, '2026.8.1')) {
    return { defaults: agents.defaults, list: Object.entries(agents.entries).map(([id, entry]) => ({ ...entry, id })) };
  }
  return { ownership: 'explicit' as const, ...agents };
}

/** Legacy Gateways classify plugin inventory as an administrative method. */
export function gatewayRequestScopes(method: string): Array<'operator.read' | 'operator.write' | 'operator.admin'> {
  if (method === 'plugins.list') return openClawContract === 'legacy-v1'
    ? ['operator.read', 'operator.admin'] : ['operator.read'];
  return method === 'tools.catalog' ? ['operator.read'] : ['operator.read', 'operator.write'];
}
