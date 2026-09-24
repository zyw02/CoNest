import { Context, type FiberState } from './adapters/dsh-cordis.js';
import { Loader, type EntryOptions } from './adapters/dsh-loader.js';
import { isDeepStrictEqual } from 'node:util';
import {
  CapabilityRegistry, componentService, dependencyState, resolveComponent, startFiber,
  startSearchInfrastructure, status, type RuntimeGeneration,
} from './components.js';
import { BridgeError, type BridgeConfig, type ComponentSpec, type ComponentStatus } from './types.js';

type ComponentNode = {
  id: string;
  spec: ComponentSpec;
  registry: CapabilityRegistry;
  dependencies: Map<string, ComponentNode>;
  scope: Record<string, symbol>;
  context?: Context;
  owners: number;
};

// Cordis publishes a const enum, not a runtime export. Keep source/tsx and built
// execution identical; the type check fails if the pinned enum value changes.
const UNLOADING: FiberState.UNLOADING = 5;

/** One native Loader; immutable graphs hold ownership of independently versioned entries. */
export class ComponentLoader {
  private readonly context = new Context();
  private readonly nodes = new WeakMap<RuntimeGeneration, Map<string, ComponentNode>>();
  private sequence = 0;
  private mutations: Promise<unknown> = Promise.resolve();
  private closePromise?: Promise<void>;
  readonly cleanupErrors: string[] = [];

  static async create(): Promise<ComponentLoader> {
    const engine = new ComponentLoader();
    await engine.context.plugin(Loader);
    // Cordis catches disposer exceptions. Observe the structured lifecycle evidence as well.
    engine.context.logger.exporter({ export(message) {
      if (message.type !== 'error' || message.fiber?.deref()?.state !== UNLOADING) return;
      engine.cleanupErrors.push(message.args.map(String).join(' ').slice(0, 2000));
      if (engine.cleanupErrors.length > 16) engine.cleanupErrors.shift();
    } });
    return engine;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => {}); // The caller receives failure; later cleanup must still run.
    return result;
  }

  prepare(config: BridgeConfig, revision: string, previous?: RuntimeGeneration): Promise<RuntimeGeneration> {
    const detached = structuredClone(config);
    return this.serial(() => this.prepareGraph(detached, revision, previous));
  }

  private async prepareGraph(config: BridgeConfig, revision: string, previous?: RuntimeGeneration): Promise<RuntimeGeneration> {
    if (this.closePromise) throw new BridgeError('BRIDGE_STOPPING', 'The component Loader is stopping');
    const accepted = previous ? this.nodes.get(previous)! : new Map<string, ComponentNode>();
    const nodes = new Map<string, ComponentNode>();
    const states = new Map<string, ComponentStatus>();
    const specs = new Map(config.components.map(spec => [spec.manifest.id, spec]));
    const pending = new Set(config.components.filter(spec => spec.enabled).map(spec => spec.manifest.id));
    for (const spec of config.components) if (!spec.enabled) states.set(spec.manifest.id, status(spec, 'disabled'));
    try {
      while (pending.size) {
        let advanced = false;
        for (const id of [...pending]) {
          const spec = specs.get(id)!;
          const dependency = dependencyState(spec, specs, states, pending);
          if (dependency.wait) continue;
          if (dependency.reason) states.set(id, status(spec, 'blocked', dependency.reason, 'dependency'));
          else {
            try {
              const dependencies = new Map(Object.keys(spec.manifest.requires).map(key => [key, nodes.get(key)!]));
              const old = accepted.get(id);
              // Dependency identity includes all actual injectable services: cross-component
              // service access is confined to the declared dependency closure below.
              const reusable = old && this.ready(old) && isDeepStrictEqual(old.spec, spec)
                && dependencies.size === old.dependencies.size
                && [...dependencies].every(([key, node]) => old.dependencies.get(key) === node);
              const node = reusable ? old : await this.mount(spec, dependencies, config.startupTimeoutMs);
              node.owners++;
              nodes.set(id, node);
              states.set(id, status(spec, 'ready'));
            } catch (error) {
              states.set(id, status(spec, 'blocked', error instanceof Error ? error.message : String(error), 'activation'));
            }
          }
          pending.delete(id);
          advanced = true;
        }
        if (!advanced) {
          for (const id of pending) states.set(id, status(specs.get(id)!, 'blocked', 'Dependency cycle detected', 'cycle'));
          pending.clear();
        }
      }
      const registry = new CapabilityRegistry(config.components.map(spec => spec.manifest), [...nodes.values()].map(node => node.registry));
      let disposal: Promise<void> | undefined;
      const generation: RuntimeGeneration = {
        revision, config, registry, refs: 0, retired: false,
        get statuses() {
          return config.components.map(spec => {
            const initial = states.get(spec.manifest.id)!;
            const node = nodes.get(spec.manifest.id);
            return initial.state !== 'ready' || (node && ComponentLoader.isReady(node)) ? initial
              : status(spec, 'blocked', 'Waiting for required services or reload', 'dependency');
          });
        },
        dispose: () => disposal ??= this.serial(() => this.releaseNodes(nodes)),
      };
      this.nodes.set(generation, nodes);
      return generation;
    } catch (error) {
      await this.releaseNodes(nodes);
      throw error;
    }
  }

  private static isReady(node: ComponentNode): boolean {
    return node.context?.get(componentService(node.spec.manifest.id)) === true
      && node.spec.manifest.capabilities.every(cap => node.registry.has(cap.name, node.spec.manifest.id));
  }

  private ready(node: ComponentNode): boolean { return ComponentLoader.isReady(node); }

  private async mount(spec: ComponentSpec, dependencies: Map<string, ComponentNode>, timeoutMs: number): Promise<ComponentNode> {
    const id = `component-${++this.sequence}`;
    const registry = new CapabilityRegistry([spec.manifest]);
    const scope: Record<string, symbol> = Object.create(null);
    // Application services, including Loader's management service, never fall
    // through to the root or to a sibling revision merely because a name is new.
    const closure = new Set<ComponentNode>();
    const visit = (node: ComponentNode) => {
      if (closure.has(node)) return;
      closure.add(node);
      for (const parent of node.dependencies.values()) visit(parent);
    };
    for (const node of dependencies.values()) visit(node);
    for (const node of closure) {
      for (const [name, symbol] of Object.entries(node.scope)) {
        if (name === 'bridgeCapabilities' || name === 'loader') continue;
        // Only the owning entry exports a service, not a consumer's inherited view.
        const implementation = this.context.reflect.store[symbol];
        if (!implementation || implementation.fiber.entry?.id !== node.id) continue;
        if (scope[name] && scope[name] !== symbol) throw new BridgeError('AMBIGUOUS_SERVICE', `Multiple declared dependencies provide ${name}`);
        scope[name] = symbol;
      }
    }
    const isolated = new Proxy(scope, {
      get(target, key) {
        if (typeof key !== 'string') return Reflect.get(target, key);
        return target[key] ??= Symbol(`${key}@${id}`);
      },
    });
    const node: ComponentNode = { id, spec, registry, dependencies, scope, owners: 0 };
    // Resolve only this approved, integrity-pinned component. Loader owns the managed
    // wrapper and all descendant fibers; no watcher or expression config is enabled.
    const loader = this.context.loader;
    this.context.loader.builtins[id] = {
      name: id,
      async apply(owner: Context) {
        const component = await resolveComponent(spec, async specifier => loader.unwrapExports(await loader.import(specifier)));
        const ctx = owner.extend({ bridgeComponentId: spec.manifest.id, [Context.isolate]: isolated });
        node.context = ctx;
        await startFiber(ctx, { apply(service: Context) { service.provide('bridgeCapabilities', registry); } }, {});
        if (spec.manifest.entry === 'builtin:dsh-search') await startSearchInfrastructure(ctx);
        const managed = {
          ...component,
          inject: [...component.inject ?? [], ...Object.keys(spec.manifest.requires).map(componentService)],
          async apply(child: Context, config: Record<string, unknown>) {
            await component.apply(child, config);
            child.provide(componentService(spec.manifest.id), true);
          },
        };
        // Pass JSON directly to the child: Loader expression interpolation must never
        // reinterpret component configuration accepted by the management JSON parser.
        await startFiber(ctx, managed, structuredClone(spec.config), timeoutMs);
      },
    };
    const options: EntryOptions = { id, name: `cordis:${id}`, isolate: { bridgeCapabilities: id } };
    try {
      // Only create the candidate. Re-applying a copied root list could revive a
      // self-disabled accepted entry behind the graph owner's back.
      await this.context.loader.create(structuredClone(options));
      if (!this.ready(node)) throw new BridgeError('INVALID_COMPONENT', `Component ${spec.manifest.id} is pending or did not register all declared capabilities`);
      return node;
    } catch (error) {
      await this.context.loader.root.remove(id);
      delete this.context.loader.builtins[id];
      throw error;
    }
  }

  private async releaseNodes(nodes: Map<string, ComponentNode>): Promise<void> {
    const failures: unknown[] = [];
    for (const node of [...nodes.values()].reverse()) {
      if (--node.owners > 0) continue;
      try { await this.context.loader.root.remove(node.id); } catch (error) { failures.push(error); }
      delete this.context.loader.builtins[node.id];
    }
    if (failures.length) throw new AggregateError(failures, 'Component entry cleanup failed');
  }

  close(): Promise<void> {
    return this.closePromise ??= this.serial(async () => {
      await this.context.loader.root.stop();
      await this.context.fiber.dispose();
    });
  }
}
