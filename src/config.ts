import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import semver from 'semver';
import { BRIDGE_VERSION, BridgeError, type BridgeConfig, type ComponentManifest, type ComponentSpec, type JsonObject } from './types.js';
import { packageIntegrity } from './package-content.js';
import { parsePolicy } from './policy.js';
import { memoryCapabilities } from './memory-contract.js';
import { ALL_PERMISSIONS, type Permission } from './types.js';
import { managedReadTools } from './read-contract.js';
import { managedSearchTools } from './search-contract.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const singleLine = '^[^\\r\\n]+$';
const objectSchema = { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 500, pattern: singleLine } }, required: ['query'] };
const builtins: ComponentManifest[] = [
  { id: 'dsh-memory', version: '0.1.0', description: 'Shared DSH memory service', entry: 'builtin:dsh-memory', requires: {}, capabilities: memoryCapabilities, configSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    id: 'dsh-read', version: '0.1.0', description: 'DSH workspace text reader', entry: 'builtin:dsh-read', requires: {},
    capabilities: managedReadTools.map(tool => ({ name: tool.openClawName, description: tool.description, inputSchema: tool.parameters, permissions: ['workspace:read'] })),
  },
  {
    id: 'dsh-search', version: '0.2.1', description: 'DSH workspace search service',
    entry: 'builtin:dsh-search', requires: {},
    capabilities: [{ name: 'knowledge_search', description: 'Search literal text in this workspace using DSH. Returns source paths, line numbers and excerpts; no model call.', inputSchema: objectSchema, permissions: ['workspace:read'] },
      ...managedSearchTools.map(tool => ({ name: tool.openClawName, description: tool.description, inputSchema: tool.parameters, permissions: ['workspace:read'] as const })).map(tool => ({ ...tool, permissions: [...tool.permissions] })),
    ],
  },
  {
    id: 'result-verifier', version: '0.2.0', description: 'Quoted-source verification component',
    entry: 'builtin:result-verifier', requires: { 'dsh-search': '^0.2.0' },
    capabilities: [{ name: 'knowledge_verify', description: 'Independently re-search workspace sources and check whether an exact quoted text occurs. This checks source text, not factual truth.', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 500, pattern: singleLine }, quote: { type: 'string', minLength: 1, maxLength: 2000, pattern: singleLine } }, required: ['query', 'quote'] }, permissions: ['workspace:read'] }],
  },
];

export function builtinComponents(): ComponentSpec[] {
  return structuredClone(builtins).map(manifest => ({ manifest, config: {}, enabled: true }));
}

/** Read only declarative JSON during host discovery; component code loads in the worker. */
export function readComponent(file: string): ComponentSpec {
  const manifestFile = realpathSync(file);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ComponentManifest;
  validateManifest(manifest);
  if (manifest.entry.startsWith('builtin:')) throw new BridgeError('INVALID_MANIFEST', 'External components cannot use a builtin entry');
  const directory = path.dirname(manifestFile);
  const entry = realpathSync(path.resolve(directory, manifest.entry));
  if (!inside(directory, entry)) throw new BridgeError('INVALID_MANIFEST', 'The component entry must stay inside its component directory');
  manifest.entry = entry;
  return { manifest, config: {}, enabled: true, manifestFile, integrity: packageIntegrity(directory) };
}

const validateManifestShape = ajv.compile({
  type: 'object', additionalProperties: false,
  required: ['id', 'version', 'description', 'entry', 'requires', 'capabilities'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
    version: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 2000 },
    entry: { type: 'string', minLength: 1, maxLength: 4096 },
    bridgeVersion: { type: 'string', minLength: 1, maxLength: 64 },
    configSchema: { type: 'object' },
    requires: { type: 'object', maxProperties: 64, additionalProperties: { type: 'string' } },
    capabilities: { type: 'array', maxItems: 64, items: {
      type: 'object', additionalProperties: false, required: ['name', 'description', 'inputSchema', 'permissions'],
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
        contextProvider: { const: 'workspace-v1' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        permissions: { type: 'array', uniqueItems: true, maxItems: 3, items: { enum: [...ALL_PERMISSIONS] } },
      },
    } },
  },
});

export function validateManifest(value: unknown): asserts value is ComponentManifest {
  if (!validateManifestShape(value)) throw new BridgeError('INVALID_MANIFEST', ajv.errorsText(validateManifestShape.errors));
  const manifest = value as ComponentManifest;
  if (!semver.valid(manifest.version)) throw new BridgeError('INVALID_MANIFEST', `Invalid component version: ${manifest.version}`);
  if (manifest.bridgeVersion && (!semver.validRange(manifest.bridgeVersion) || !semver.satisfies(BRIDGE_VERSION, manifest.bridgeVersion))) {
    throw new BridgeError('INCOMPATIBLE_COMPONENT', `Component requires CoNest Runtime ${manifest.bridgeVersion}; installed ${BRIDGE_VERSION}`);
  }
  if (manifest.configSchema) {
    if (manifest.configSchema.type !== 'object') throw new BridgeError('INVALID_MANIFEST', 'Component configuration schemas must describe objects');
    try { ajv.compile(manifest.configSchema); } catch (error) { throw new BridgeError('INVALID_MANIFEST', String(error)); }
  }
  for (const range of Object.values(manifest.requires)) if (!semver.validRange(range)) throw new BridgeError('INVALID_MANIFEST', `Invalid dependency version range: ${range}`);
  for (const capability of manifest.capabilities) {
    if (['bridge_capabilities', 'bridge_invoke'].includes(capability.name)) throw new BridgeError('INVALID_MANIFEST', `Capability name ${capability.name} is reserved by the adapter`);
    if (capability.inputSchema.type !== 'object') throw new BridgeError('INVALID_MANIFEST', 'Capability input schemas must describe JSON objects');
    try { ajv.compile(capability.inputSchema); } catch (error) { throw new BridgeError('INVALID_MANIFEST', String(error)); }
    if (capability.outputSchema) {
      try { ajv.compile(capability.outputSchema); } catch (error) { throw new BridgeError('INVALID_MANIFEST', String(error)); }
    }
  }
}

const configKeys = new Set(['memoryFilePath', 'workspaceRoot', 'components', 'builtins', 'permissions', 'capabilityPolicy', 'maxConcurrent', 'maxQueued', 'maxTasks', 'taskTtlMs', 'startupTimeoutMs', 'shutdownTimeoutMs', 'maxPayloadBytes', 'maxRetiredGenerations', 'abortGraceMs']);
export function resolveConfig(input: JsonObject = {}, base = process.cwd(), memoryFileOverride?: string): BridgeConfig {
  for (const key of Object.keys(input)) if (!configKeys.has(key)) throw new BridgeError('INVALID_CONFIG', `Unknown configuration field: ${key}`);
  const workspace = input.workspaceRoot ?? base;
  if (typeof workspace !== 'string') throw new BridgeError('INVALID_CONFIG', 'workspaceRoot must be a path string');
  const workspaceRoot = realpathSync(path.resolve(base, workspace));
  if (!statSync(workspaceRoot).isDirectory()) throw new BridgeError('INVALID_CONFIG', 'workspaceRoot must be a directory');
  const memoryPath = input.memoryFilePath ?? memoryFileOverride;
  if (memoryPath !== undefined && (typeof memoryPath !== 'string' || !memoryPath.trim())) throw new BridgeError('INVALID_CONFIG', 'memoryFilePath must be a non-empty path');
  const memoryFilePath = typeof memoryPath === 'string' ? path.resolve(base, memoryPath) : undefined;
  const rawComponents = input.components ?? [];
  if (!Array.isArray(rawComponents) || rawComponents.length > 64) throw new BridgeError('INVALID_CONFIG', 'components must be an array of at most 64 entries');
  const components: ComponentSpec[] = [
    ...configuredBuiltins(input.builtins),
    ...rawComponents.map((item: unknown) => {
      if (typeof item === 'string') return configureComponent(readComponent(path.resolve(base, item)), {});
      const entry = object(item, 'Component configuration');
      allowedKeys(entry, ['manifest', 'enabled', 'config', 'integrity']);
      if (typeof entry.manifest !== 'string') throw new BridgeError('INVALID_CONFIG', 'External components require a manifest path');
      const component = configureComponent(readComponent(path.resolve(base, entry.manifest)), entry);
      if (entry.integrity !== undefined && entry.integrity !== component.integrity) {
        throw new BridgeError('INTEGRITY_MISMATCH', `Component bundle changed after installation: ${component.manifest.id}`);
      }
      return component;
    }),
  ];
  const memory = components.find(c => c.manifest.id === 'dsh-memory')!;
  memory.enabled &&= !!memoryFilePath;
  memory.config = memoryFilePath ? { file: memoryFilePath } : {};
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const { manifest } of components) {
    if (ids.has(manifest.id)) throw new BridgeError('INVALID_CONFIG', `Duplicate component id: ${manifest.id}`);
    ids.add(manifest.id);
    for (const capability of manifest.capabilities) {
      if (names.has(capability.name)) throw new BridgeError('INVALID_CONFIG', `Duplicate capability name: ${capability.name}`);
      names.add(capability.name);
    }
  }
  const permissions = input.permissions ?? (memoryFilePath ? [...ALL_PERMISSIONS] : ['workspace:read']);
  if (!Array.isArray(permissions) || permissions.some(p => !ALL_PERMISSIONS.includes(p))) throw new BridgeError('INVALID_CONFIG', 'Unknown permission; supported permissions are workspace:read, memory:read, memory:write');
  return {
    workspaceRoot, ...(memoryFilePath ? { memoryFilePath } : {}), components, permissions: [...new Set(permissions)] as Permission[],
    capabilityPolicy: parsePolicy(input.capabilityPolicy),
    maxConcurrent: integer(input, 'maxConcurrent', 4, 1, 64),
    maxQueued: integer(input, 'maxQueued', 32, 0, 1024),
    maxTasks: integer(input, 'maxTasks', 128, 1, 4096),
    taskTtlMs: integer(input, 'taskTtlMs', 120_000, 100, 3_600_000),
    startupTimeoutMs: integer(input, 'startupTimeoutMs', 15_000, 100, 120_000),
    shutdownTimeoutMs: integer(input, 'shutdownTimeoutMs', 5_000, 100, 30_000),
    maxPayloadBytes: integer(input, 'maxPayloadBytes', 256_000, 1024, 2_000_000),
    maxRetiredGenerations: integer(input, 'maxRetiredGenerations', 2, 1, 8),
    abortGraceMs: integer(input, 'abortGraceMs', 1_000, 100, 10_000),
  };
}

function configuredBuiltins(value: unknown): ComponentSpec[] {
  const overrides = value === undefined ? {} : object(value, 'Built-in configuration');
  const builtins = builtinComponents();
  allowedKeys(overrides, builtins.map(component => component.manifest.id));
  return builtins.map(component => {
    const override = overrides[component.manifest.id];
    if (override === undefined) return component;
    const entry = object(override, 'Built-in component configuration');
    allowedKeys(entry, ['enabled', 'config']);
    return configureComponent(component, entry);
  });
}

function configureComponent(component: ComponentSpec, entry: JsonObject): ComponentSpec {
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new BridgeError('INVALID_CONFIG', 'Component enabled must be a boolean');
  component.enabled = entry.enabled !== false;
  component.config = entry.config === undefined ? {} : object(entry.config, 'Component config');
  if (component.manifest.configSchema) {
    const validate = ajv.compile(component.manifest.configSchema);
    if (!validate(component.config)) throw new BridgeError('INVALID_CONFIG', `Invalid configuration for ${component.manifest.id}: ${ajv.errorsText(validate.errors)}`);
  }
  return component;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_CONFIG', `${label} must be a JSON object`);
  return value as JsonObject;
}

function allowedKeys(value: JsonObject, keys: string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new BridgeError('INVALID_CONFIG', `Unknown configuration field: ${key}`);
}

function integer(input: JsonObject, key: string, fallback: number, min: number, max: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new BridgeError('INVALID_CONFIG', `${key} must be an integer from ${min} through ${max}`);
  return value;
}
export function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function revision(config: BridgeConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 24);
}
export function readConfig(file: string, memoryFileOverride?: string): BridgeConfig {
  return resolveConfig(JSON.parse(readFileSync(file, 'utf8')), path.dirname(path.resolve(file)), memoryFileOverride);
}
export function bundledRoot(): string { return path.dirname(fileURLToPath(import.meta.url)); }
