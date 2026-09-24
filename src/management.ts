import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { inside, readComponent, resolveConfig } from './config.js';
import { packageIntegrity } from './package-content.js';
import { parsePolicy } from './policy.js';
import type { BridgeRuntime } from './runtime.js';
import { BridgeError, type JsonObject, type RuntimeStatus } from './types.js';

export type ComponentOperation = (
  | { action: 'install'; manifest: string; config?: JsonObject }
  | { action: 'upgrade'; id: string; manifest: string }
  | { action: 'enable' | 'disable' | 'uninstall'; id: string }
  | { action: 'configure'; id: string; config: JsonObject }
  | { action: 'policy'; policy: JsonObject }
) & { expectedRevision?: string };

/** The worker is the single writer for persisted component configuration. */
export class ComponentManager {
  private raw: JsonObject;
  private diskDigest: string;
  private busy = false;

  constructor(private readonly runtime: BridgeRuntime, private readonly configFile: string, private readonly memoryFileOverride?: string) {
    const contents = readFileSync(configFile, 'utf8');
    this.raw = JSON.parse(contents) as JsonObject;
    this.diskDigest = digest(contents);
  }

  async reload(): Promise<RuntimeStatus> {
    return await this.exclusive(async () => {
      const contents = readFileSync(this.configFile, 'utf8');
      const raw = JSON.parse(contents) as JsonObject;
      const status = await this.runtime.reload(resolveConfig(raw, path.dirname(this.configFile), this.memoryFileOverride));
      this.raw = raw;
      this.diskDigest = digest(contents);
      return status;
    });
  }

  async apply(operation: ComponentOperation): Promise<RuntimeStatus> {
    return await this.exclusive(async () => {
      const current = this.runtime.status();
      if (operation.expectedRevision && operation.expectedRevision !== current.revision) {
        throw new BridgeError('STALE_REVISION', 'Component state changed; inspect the current state before retrying the management operation');
      }
      this.assertDiskUnchanged();
      const next = structuredClone(this.raw);
      const components = normalizeEntries(next.components, path.dirname(this.configFile));
      next.components = components;
      if (operation.action === 'policy') {
        next.capabilityPolicy = parsePolicy(operation.policy);
      } else if (operation.action === 'install' || operation.action === 'upgrade') {
        const candidate = await snapshotPackage(operation.manifest, this.configFile);
        const index = components.findIndex(entry => readComponent(entry.manifest as string).manifest.id === candidate.id);
        if (operation.action === 'install') {
          if (current.components.some(component => component.id === candidate.id)) throw new BridgeError('COMPONENT_EXISTS', `Component ${candidate.id} is already installed`);
          components.push({ manifest: candidate.manifest, integrity: candidate.integrity, enabled: true, config: operation.config ?? {} });
        } else {
          if (candidate.id !== operation.id || index < 0) throw new BridgeError('COMPONENT_NOT_FOUND', 'An upgrade must name an installed external component with the same id');
          const previous = current.components.find(component => component.id === operation.id)!;
          if (previous.version === candidate.version && previous.integrity !== candidate.integrity) {
            throw new BridgeError('VERSION_REUSE', 'Changed executable content requires a new component version');
          }
          components[index] = { ...components[index], manifest: candidate.manifest, integrity: candidate.integrity };
        }
      } else {
        const installed = current.components.find(component => component.id === operation.id);
        if (!installed) throw new BridgeError('COMPONENT_NOT_FOUND', `Component ${operation.id} is not installed`);
        const index = components.findIndex(entry => readComponent(entry.manifest as string).manifest.id === operation.id);
        if (index < 0) {
          if (operation.action === 'uninstall') throw new BridgeError('BUILTIN_COMPONENT', 'Built-in components can be disabled but cannot be uninstalled');
          const builtins = (next.builtins ?? {}) as JsonObject;
          const entry = (builtins[operation.id] ?? {}) as JsonObject;
          builtins[operation.id] = changeEntry(entry, operation);
          next.builtins = builtins;
        } else if (operation.action === 'uninstall') components.splice(index, 1);
        else components[index] = changeEntry(components[index]!, operation);
      }
      const resolved = resolveConfig(next, path.dirname(this.configFile), this.memoryFileOverride);
      const encoded = `${JSON.stringify(next, null, 2)}\n`;
      const status = await this.runtime.reload(resolved, async () => {
        this.assertDiskUnchanged();
        await atomicWrite(this.configFile, encoded);
      });
      this.raw = next;
      this.diskDigest = digest(encoded);
      return status;
    });
  }

  private assertDiskUnchanged(): void {
    if (digest(readFileSync(this.configFile, 'utf8')) !== this.diskDigest) {
      throw new BridgeError('CONFIG_CONFLICT', 'The configuration file was edited externally; reload it before applying another component operation');
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BridgeError('MANAGEMENT_BUSY', 'Another component management operation is in progress');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}

export function parseOperation(value: unknown): ComponentOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_REQUEST', 'A component operation must be an object');
  const operation = value as JsonObject;
  const action = operation.action;
  if (action === 'policy') {
    if (Object.keys(operation).some(key => !['action', 'policy', 'expectedRevision'].includes(key))
      || (operation.expectedRevision !== undefined && typeof operation.expectedRevision !== 'string')) throw new BridgeError('INVALID_REQUEST', 'Invalid policy management operation');
    parsePolicy(operation.policy);
    if (operation.policy === undefined) throw new BridgeError('INVALID_REQUEST', 'A policy object is required');
    return operation as ComponentOperation;
  }
  if (!['install', 'upgrade', 'enable', 'disable', 'uninstall', 'configure'].includes(String(action))) throw new BridgeError('INVALID_REQUEST', 'Unsupported component operation');
  const keys = ['action', 'expectedRevision'];
  if (action === 'install' || action === 'upgrade') keys.push('manifest');
  if (action !== 'install') keys.push('id');
  if (action === 'install' || action === 'configure') keys.push('config');
  if (Object.keys(operation).some(key => !keys.includes(key))) throw new BridgeError('INVALID_REQUEST', 'Unknown component operation field');
  if (action !== 'install' && (typeof operation.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(operation.id))) throw new BridgeError('INVALID_REQUEST', 'The component id is invalid');
  if ((action === 'install' || action === 'upgrade') && typeof operation.manifest !== 'string') throw new BridgeError('INVALID_REQUEST', 'A component manifest path is required');
  if (operation.expectedRevision !== undefined && typeof operation.expectedRevision !== 'string') throw new BridgeError('INVALID_REQUEST', 'expectedRevision must be a string');
  if ((action === 'configure' || operation.config !== undefined)
    && (!operation.config || typeof operation.config !== 'object' || Array.isArray(operation.config))) throw new BridgeError('INVALID_REQUEST', 'Component config must be an object');
  return operation as ComponentOperation;
}

function changeEntry(entry: JsonObject, operation: { action: 'enable' | 'disable' | 'uninstall' | 'configure'; config?: JsonObject }): JsonObject {
  if (operation.action === 'uninstall') throw new BridgeError('INVALID_REQUEST', 'Uninstall removes the component entry');
  return operation.action === 'configure' ? { ...entry, config: operation.config } : { ...entry, enabled: operation.action === 'enable' };
}

function normalizeEntries(value: unknown, base: string): JsonObject[] {
  return ((value ?? []) as Array<string | JsonObject>).map(entry => typeof entry === 'string'
    ? { manifest: realpathSync(path.resolve(base, entry)), enabled: true, config: {} }
    : { ...entry, manifest: realpathSync(path.resolve(base, entry.manifest as string)) });
}

async function snapshotPackage(manifest: string, configFile: string): Promise<{ id: string; version: string; integrity: string; manifest: string }> {
  const component = readComponent(path.resolve(manifest));
  const source = path.dirname(component.manifestFile!);
  const packageRoot = path.join(path.dirname(configFile), '.dsh-bridge', digest(configFile).slice(0, 12), 'packages');
  if (inside(source, packageRoot)) throw new BridgeError('INVALID_PACKAGE', 'Keep the component bundle in its own directory outside the configuration and package store');
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  const target = path.join(packageRoot, `${component.manifest.id}-${component.manifest.version}-${component.integrity!.slice(0, 16)}`);
  try {
    const exists = await stat(target);
    if (!exists.isDirectory() || packageIntegrity(target) !== component.integrity) throw new BridgeError('INTEGRITY_MISMATCH', 'An installed component snapshot was modified');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const staging = await mkdtemp(path.join(packageRoot, '.staging-'));
    try {
      await cp(source, staging, { recursive: true, dereference: false });
      if (packageIntegrity(staging) !== component.integrity) throw new BridgeError('PACKAGE_CHANGED', 'The component package changed while being installed');
      await rename(staging, target);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return { id: component.manifest.id, version: component.manifest.version, integrity: component.integrity!, manifest: path.join(target, path.basename(component.manifestFile!)) };
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
