import { Context, type CordisContext, type Fiber } from './adapters/dsh-cordis.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Ajv, type ValidateFunction } from 'ajv';
import semver from 'semver';
import { pathToFileURL } from 'node:url';
import type {
  BridgeConfig,
  CapabilityDescriptor,
  CapabilityHandler,
  ComponentManifest,
  ComponentModule,
  ComponentSpec,
  ComponentStatus,
  Invocation,
  JsonObject,
  Permission,
  PublishedCapability,
} from './types.js';
import { BridgeError } from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    bridgeCapabilities: CapabilityRegistry;
    bridgeComponentId?: string;
  }
}

type HandlerRecord = {
  componentId: string;
  descriptor: CapabilityDescriptor;
  handler: CapabilityHandler;
  validate: ValidateFunction;
  validateOutput?: ValidateFunction;
  available(): boolean;
  signal: AbortSignal;
};

/** Component-owned registrations or a graph-local view; nested calls retain their admitted graph. */
export class CapabilityRegistry {
  private static readonly calls = new AsyncLocalStorage<CapabilityRegistry>();
  private readonly sources: readonly CapabilityRegistry[];
  private readonly handlers = new Map<string, HandlerRecord>();
  private readonly declarations = new Map<string, { componentId: string; descriptor: CapabilityDescriptor }>();
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly manifests = new Map<string, ComponentManifest>();

  constructor(manifests: ComponentManifest[], sources: CapabilityRegistry[] = []) {
    this.sources = Object.freeze([...sources]);
    for (const manifest of manifests) {
      this.manifests.set(manifest.id, manifest);
      for (const descriptor of manifest.capabilities) {
        this.declarations.set(descriptor.name, { componentId: manifest.id, descriptor });
      }
    }
  }

  private records(): Map<string, HandlerRecord> {
    return this.sources.length ? new Map(this.sources.flatMap(source => [...source.handlers])) : this.handlers;
  }

  register(owner: Context, name: string, handler: CapabilityHandler): void {
    const componentId = owner.bridgeComponentId;
    if (!componentId) throw new BridgeError('INVALID_COMPONENT', `Capability ${name} was registered outside a component context`);
    const declaration = this.declarations.get(name);
    if (!declaration || declaration.componentId !== componentId) {
      throw new BridgeError('INVALID_COMPONENT', `Component ${componentId} did not declare capability ${name}`);
    }
    if (this.handlers.has(name)) throw new BridgeError('INVALID_COMPONENT', `Capability ${name} is already registered`);
    const lifetime = new AbortController();
    const record = {
      componentId,
      descriptor: declaration.descriptor,
      handler,
      validate: this.ajv.compile(declaration.descriptor.inputSchema),
      validateOutput: declaration.descriptor.outputSchema ? this.ajv.compile(declaration.descriptor.outputSchema) : undefined,
      available: () => owner.get(componentService(componentId)) === true,
      signal: lifetime.signal,
    };
    this.handlers.set(name, record);
    owner.effect(() => () => {
      lifetime.abort(new BridgeError('CAPABILITY_UNAVAILABLE', `Component ${componentId} stopped while providing ${name}`));
      if (this.handlers.get(name) === record) this.handlers.delete(name);
    }, `bridge capability ${name}`);
  }

  has(name: string, componentId?: string): boolean {
    const record = this.records().get(name);
    return record !== undefined && record.available() && (componentId === undefined || record.componentId === componentId);
  }

  descriptors(): PublishedCapability[] {
    return [...this.records().values()].filter(record => record.available()).map(record => ({
      ...structuredClone(record.descriptor),
      provider: { id: record.componentId, version: this.manifests.get(record.componentId)!.version },
    }));
  }

  descriptor(name: string): CapabilityDescriptor | undefined {
    const record = this.records().get(name);
    const descriptor = record?.available() ? record.descriptor : undefined;
    return descriptor ? structuredClone(descriptor) : undefined;
  }

  async invoke(name: string, args: JsonObject, invocation: Invocation): Promise<unknown> {
    const graph = CapabilityRegistry.calls.getStore();
    if (graph && graph !== this) return graph.invoke(name, args, invocation);
    invocation.signal.throwIfAborted();
    const records = this.records();
    const record = records.get(name);
    if (!record?.available()) throw new BridgeError('CAPABILITY_UNAVAILABLE', `Capability ${name} is not available`);
    if (!invocation.allowedCapabilities.includes(name)) throw new BridgeError('CAPABILITY_DENIED', `The task policy denies capability ${name}`);
    if (!hasPermissions(record.descriptor.permissions, invocation.permissions)) {
      throw new BridgeError('PERMISSION_DENIED', `Capability ${name} exceeds the task permission grant`);
    }
    if (invocation.capabilityPath.includes(name) || invocation.capabilityPath.length >= 16) {
      throw new BridgeError('CAPABILITY_CYCLE', `Recursive capability invocation rejected: ${name}`);
    }
    const callerName = invocation.capabilityPath.at(-1);
    const caller = callerName ? records.get(callerName) : undefined;
    if (caller && caller.componentId !== record.componentId
      && !this.manifests.get(caller.componentId)!.requires[record.componentId]) {
      throw new BridgeError('DEPENDENCY_UNDECLARED', `Component ${caller.componentId} did not declare dependency ${record.componentId}`);
    }
    if (!record.validate(args)) {
      throw new BridgeError('INVALID_ARGUMENTS', this.ajv.errorsText(record.validate.errors));
    }
    const signal = AbortSignal.any([invocation.signal, record.signal]);
    const result = await CapabilityRegistry.calls.run(this, () => record.handler(args, { ...invocation, signal, capabilityPath: [...invocation.capabilityPath, name] }));
    signal.throwIfAborted();
    if (record.validateOutput && !record.validateOutput(result)) {
      throw new BridgeError('INVALID_COMPONENT_RESULT', `Invalid output from ${name}: ${this.ajv.errorsText(record.validateOutput.errors)}`);
    }
    return result;
  }
}

export type RuntimeGeneration = {
  revision: string;
  config: BridgeConfig;
  registry: CapabilityRegistry;
  statuses: ComponentStatus[];
  refs: number;
  retired: boolean;
  dispose(): Promise<void>;
};

const resultVerifierComponent: ComponentModule<CordisContext> = {
  name: 'result-verifier',
  inject: ['bridgeCapabilities'],
  apply(ctx) {
    ctx.bridgeCapabilities.register(ctx, 'knowledge_verify', async (args, invocation) => {
      const query = args.query as string;
      const quote = args.quote as string;
      invocation.progress('Finding candidate sources');
      const queryResult = readSearchResult(await ctx.bridgeCapabilities.invoke(
        'knowledge_search', { query }, childInvocation(invocation, 'query'),
      ));
      invocation.progress('Checking the quoted text in candidate sources');
      const quoteResult = query === quote
        ? queryResult
        : readSearchResult(await ctx.bridgeCapabilities.invoke(
          'knowledge_search', { query: quote }, childInvocation(invocation, 'quote'),
        ));
      const candidatePaths = new Set(queryResult.matches.map(match => match.path));
      const evidence = quoteResult.matches.filter(match => candidatePaths.has(match.path));
      return {
        verified: evidence.length > 0,
        query,
        quote,
        sources: evidence.slice(0, 20),
        candidateSourceCount: candidatePaths.size,
        explanation: evidence.length > 0
          ? 'The exact quoted text occurs in a source that also matches the query.'
          : 'No source matching the query also contained the exact quoted text.',
      };
    });
  },
};

const builtins = new Map<string, ComponentModule<CordisContext>>([
  ['builtin:result-verifier', resultVerifierComponent],
]);


export function componentService(id: string): string { return `bridge-component:${id}`; }

/** Infrastructure belongs to the search entry, never to unrelated graph revisions. */
export async function startSearchInfrastructure(ctx: Context): Promise<void> {
  await (await import('./dsh-search-component.js')).startSearchInfrastructure(ctx);
}

export async function startFiber(ctx: Context, plugin: object, config: JsonObject, timeoutMs = 15_000): Promise<Fiber> {
  const fiber = ctx.plugin(plugin as never, config as never);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fiber,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BridgeError('COMPONENT_START_TIMEOUT', 'Component activation exceeded its startup deadline')), timeoutMs);
        timer.unref();
      }),
    ]);
    return fiber;
  } catch (error) {
    await fiber.dispose();
    throw error;
  } finally { clearTimeout(timer); }
}

export async function resolveComponent(spec: ComponentSpec, importModule: (specifier: string) => Promise<unknown>): Promise<ComponentModule<CordisContext>> {
  if (spec.manifest.entry === 'builtin:dsh-search') return (await import('./dsh-search-component.js')).dshSearchComponent;
  if (spec.manifest.entry === 'builtin:dsh-read') return (await import('./read-component.js')).dshReadComponent;
  if (spec.manifest.entry === 'builtin:dsh-memory') return (await import('./memory-component.js')).dshMemoryComponent;
  const builtin = builtins.get(spec.manifest.entry);
  if (builtin) return builtin;
  const specifier = `${pathToFileURL(spec.manifest.entry).href}?version=${encodeURIComponent(spec.manifest.version)}&integrity=${spec.integrity ?? ''}`;
  const component = await importModule(specifier) as Partial<ComponentModule<CordisContext>>;
  if (typeof component.apply !== 'function') throw new BridgeError('INVALID_COMPONENT', `${spec.manifest.id} does not export a Cordis component`);
  return component as ComponentModule<CordisContext>;
}

export function dependencyState(
  spec: ComponentSpec,
  specs: Map<string, ComponentSpec>,
  statuses: Map<string, ComponentStatus>,
  pending: Set<string>,
): { wait?: true; reason?: string } {
  for (const [id, range] of Object.entries(spec.manifest.requires)) {
    const dependency = specs.get(id);
    if (!dependency) return { reason: `Missing dependency ${id}@${range}` };
    if (!semver.satisfies(dependency.manifest.version, range)) {
      return { reason: `Dependency ${id}@${dependency.manifest.version} does not satisfy ${range}` };
    }
    if (pending.has(id)) return { wait: true };
    const dependencyStatus = statuses.get(id);
    if (dependencyStatus?.state !== 'ready') return { reason: `Dependency ${id} is ${dependencyStatus?.state ?? 'unavailable'}` };
  }
  return {};
}

export function status(spec: ComponentSpec, state: ComponentStatus['state'], reason?: string, reasonCode?: ComponentStatus['reasonCode']): ComponentStatus {
  return {
    id: spec.manifest.id, version: spec.manifest.version, state,
    enabled: spec.enabled, requires: structuredClone(spec.manifest.requires),
    ...(spec.integrity ? { integrity: spec.integrity } : {}),
    ...(reason ? { reason, reasonCode } : {}),
  };
}

type SearchMatch = { path: string; lineNumber: number; line: string };
type SearchResult = { matches: SearchMatch[] };

function readMatches(value: unknown): SearchMatch[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { matches?: unknown }).matches)) {
    throw new BridgeError('INVALID_COMPONENT_RESULT', 'DSH search returned an invalid result');
  }
  return (value as { matches: unknown[] }).matches.map(item => {
    if (!item || typeof item !== 'object') throw new BridgeError('INVALID_COMPONENT_RESULT', 'DSH search returned an invalid match');
    const match = item as Partial<SearchMatch>;
    if (typeof match.path !== 'string' || typeof match.lineNumber !== 'number' || typeof match.line !== 'string') {
      throw new BridgeError('INVALID_COMPONENT_RESULT', 'DSH search returned an invalid match');
    }
    return { path: match.path, lineNumber: match.lineNumber, line: match.line };
  });
}

function readSearchResult(value: unknown): SearchResult {
  if (!value || typeof value !== 'object') throw new BridgeError('INVALID_COMPONENT_RESULT', 'Search component returned an invalid result');
  return { matches: readMatches(value) };
}

function childInvocation(parent: Invocation, suffix: string): Invocation {
  return { ...parent, callId: `${parent.callId}:${suffix}` };
}

export function hasPermissions(required: Permission[], available: Permission[]): boolean {
  const granted = new Set(available);
  return required.every(permission => granted.has(permission));
}
