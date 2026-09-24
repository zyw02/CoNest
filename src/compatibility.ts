import semver from 'semver';

export const OPENCLAW_TESTED_VERSION = '2026.9.2';
export const OPENCLAW_COMPATIBILITY_RANGE = '>=2026.9.2 <2027.0.0';
export const DSH_TESTED_VERSIONS = ['0.1.0-rc.5', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.6-alpha.2'] as const;
export const DSH_TESTED_VERSION = DSH_TESTED_VERSIONS[0];
export const DSH_COMPATIBILITY_RANGE = '0.1.0-rc.5 || 0.1.0-rc.7 || 0.1.0-rc.8 || 0.1.6-alpha.2';
export const CORDIS_COMPATIBILITY_RANGE = '4.0.1 || 4.0.2';

export type Compatibility = {
  name: 'OpenClaw' | 'DSH' | 'Cordis';
  installed: string;
  supported: string;
  tested: boolean;
};

export function inspectCompatibility(
  name: Compatibility['name'],
  installed: unknown,
  supported: string,
  testedVersions: readonly string[],
): Compatibility {
  if (typeof installed !== 'string' || !semver.valid(installed)) {
    throw new Error(`${name} did not expose a valid semantic version: ${String(installed)}`);
  }
  if (!semver.satisfies(installed, supported, { includePrerelease: true })) {
    throw new Error(`${name} ${installed} is outside CoNest's supported range ${supported}`);
  }
  return { name, installed, supported, tested: testedVersions.includes(installed) };
}

export function inspectOpenClaw(installed: unknown): Compatibility {
  return inspectCompatibility('OpenClaw', installed, OPENCLAW_COMPATIBILITY_RANGE, [OPENCLAW_TESTED_VERSION, '2026.9.5']);
}

export function inspectDsh(installed: unknown): Compatibility {
  return inspectCompatibility('DSH', installed, DSH_COMPATIBILITY_RANGE, DSH_TESTED_VERSIONS);
}
