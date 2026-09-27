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
export function openClawApiVersion(version: string): string {
  return version.replace(/-\d+$/, '');
}

export function openClawContractForVersion(version: string): 'scoped-v2' | 'legacy-v1' {
  return semver.gte(openClawApiVersion(version), '2026.9.2') ? 'scoped-v2' : 'legacy-v1';
}

export const openClawContract = openClawContractForVersion(openClawVersion);

export function usesLegacyAgentList(version: string): boolean {
  return semver.lt(openClawApiVersion(version), '2026.8.1');
}

export function supportsGatewayRuntimePatch(version: string): boolean {
  return semver.gte(openClawApiVersion(version), '2026.9.5');
}

/** Serialize generated agent configuration using the host's public schema. */
export function createHostAgentsConfig<T extends object, E extends object>(agents: {
  defaults: T; entries: Record<string, E>;
}) {
  if (usesLegacyAgentList(openClawVersion)) {
    return { defaults: agents.defaults, list: Object.entries(agents.entries).map(([id, entry]) => ({ ...entry, id })) };
  }
  return { ownership: 'explicit' as const, ...agents };
}

/** Numeric host repacks implement the API of their base release. */
export function assertPluginHostCompatibility(requiredApi: unknown): void {
  if (typeof requiredApi !== 'string' || !semver.validRange(requiredApi)
    || !semver.satisfies(openClawApiVersion(openClawVersion), requiredApi)) {
    throw new Error(`Provider requires OpenClaw ${String(requiredApi)}; installed ${openClawVersion}. Install the provider release matching the host.`);
  }
}
