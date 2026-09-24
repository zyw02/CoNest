import { resolveAutomaticMemorySubject } from './studio/automatic-memory.js';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig, Invocation, JsonObject, Permission, Progress, RuntimeStatus } from './types.js';
import { BridgeError, HOST_VERSION, PROTOCOL_VERSION } from './types.js';
import { OPENCLAW_COMPATIBILITY_RANGE } from './compatibility.js';
import { hasPermissions, type RuntimeGeneration } from './components.js';
import { ComponentLoader } from './loader-runtime.js';
import { revision } from './config.js';
import { CallAuthority, type AuthorizationRequest, type CallGrant, type CallScope } from './authorization.js';
import { allowsCapability, parseCeiling, parsePrincipal, policyRules } from './policy.js';
import type { CatalogRequest, CapabilityCatalog } from './types.js';
import { isDeepStrictEqual } from 'node:util';

type TaskRecord = {
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
  authorization: string;
};

type QueueJob<T> = {
  signal: AbortSignal;
  run(): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  abort(): void;
};

class TaskScheduler {
  private activeCount = 0;
  private readonly queue: QueueJob<unknown>[] = [];

  constructor(private maxConcurrent: number, private maxQueued: number) {}

  get active(): number { return this.activeCount; }
  get queued(): number { return this.queue.length; }

  configure(maxConcurrent: number, maxQueued: number): void {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.drain();
  }

  submit<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.activeCount >= this.maxConcurrent && this.queue.length >= this.maxQueued) {
      return Promise.reject(new BridgeError('QUEUE_FULL', 'The CoNest Runtime queue is full; retry after an active task finishes'));
    }
    return new Promise<T>((resolve, reject) => {
      const job: QueueJob<T> = {
        signal,
        run,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(job as QueueJob<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason ?? new BridgeError('TASK_CANCELLED', 'The task was cancelled'));
        },
      };
      if (this.activeCount < this.maxConcurrent) this.start(job);
      else {
        this.queue.push(job as QueueJob<unknown>);
        signal.addEventListener('abort', job.abort, { once: true });
      }
    });
  }

  private start<T>(job: QueueJob<T>): void {
    job.signal.removeEventListener('abort', job.abort);
    if (job.signal.aborted) {
      job.reject(job.signal.reason);
      this.drain();
      return;
    }
    this.activeCount += 1;
    void job.run().then(job.resolve, job.reject).finally(() => {
      this.activeCount -= 1;
      this.drain();
    });
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      this.start(this.queue.shift()!);
    }
  }
}

export type InvokeRequest = CallScope & {
  args: JsonObject;
  authorization: string;
};
export type InvokeResult = { value: unknown; generation: string };

/** Owns immutable component generations and the bounded task scheduler. */
export class BridgeRuntime {
  private readonly scheduler: TaskScheduler;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly retired: RuntimeGeneration[] = [];
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly authority = new CallAuthority();
  private reloading: Promise<RuntimeStatus> | undefined;
  private lastReloadError: string | undefined;
  private readonly cleanupErrors: string[] = [];
  private policyDenials = 0;

  private constructor(
    private current: RuntimeGeneration,
    private readonly loader: ComponentLoader,
    private readonly emitProgress: (progress: Progress) => void,
    private readonly onUnresponsive: (taskId: string) => void,
  ) {
    this.scheduler = new TaskScheduler(current.config.maxConcurrent, current.config.maxQueued);
  }

  static async create(config: BridgeConfig, emitProgress: (progress: Progress) => void, onUnresponsive: (taskId: string) => void = () => {}): Promise<BridgeRuntime> {
    const detached = structuredClone(config);
    const loader = await ComponentLoader.create();
    try {
      const generation = await loader.prepare(detached, graphRevision(detached));
      return new BridgeRuntime(generation, loader, emitProgress, onUnresponsive);
    } catch (error) { await loader.close(); throw error; }
  }

  status(): RuntimeStatus {
    const blocked = this.current.statuses.some(component => component.state === 'blocked');
    const cleanupErrors = [...this.cleanupErrors, ...this.loader.cleanupErrors].slice(-16);
    return {
      protocol: PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
      hostCompatibility: OPENCLAW_COMPATIBILITY_RANGE,
      pid: process.pid,
      revision: this.current.revision,
      state: blocked || cleanupErrors.length > 0 ? 'degraded' : 'ready',
      components: structuredClone(this.current.statuses),
      capabilities: this.current.registry.descriptors().filter(capability => hasPermissions(capability.permissions, this.current.config.permissions)),
      active: this.scheduler.active,
      queued: this.scheduler.queued,
      tasks: this.tasks.size,
      retiredGenerations: this.retired.length,
      memoryRssBytes: process.memoryUsage.rss(),
      grants: this.authority.size,
      policyDenials: this.policyDenials,
      capabilityPolicy: structuredClone(this.current.config.capabilityPolicy),
      ...(this.lastReloadError ? { lastReloadError: this.lastReloadError } : {}),
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
    };
  }

  catalog(request: CatalogRequest): CapabilityCatalog {
    const rules = this.rules(request);
    return { generation: this.current.revision, capabilities: this.current.registry.descriptors().filter(capability =>
      hasPermissions(capability.permissions, this.current.config.permissions) && hasPermissions(capability.permissions, request.permissions)
      && allowsCapability(capability.name, rules)) };
  }

  private rules(request: CatalogRequest) {
    return policyRules(this.current.config.capabilityPolicy, parsePrincipal(request.principal), parseCeiling(request.capabilityCeiling));
  }

  authorize(request: AuthorizationRequest): CallGrant {
    if (this.closing) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime is stopping');
    if (!allowsCapability(request.capability, this.rules(request))) {
      this.policyDenials++;
      throw new BridgeError('CAPABILITY_DENIED', `The task policy denies capability ${request.capability}`);
    }
    for (const value of [request.taskId, request.callId, request.subject]) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new BridgeError('INVALID_REQUEST', 'Bounded task, call, and subject identifiers are required');
    }
    if (this.tasks.has(request.taskId) || this.authority.hasTask(request.taskId)) throw new BridgeError('DUPLICATE_TASK', `Task ${request.taskId} is already active`);
    if (this.tasks.size + this.authority.size >= this.current.config.maxTasks) throw new BridgeError('TOO_MANY_TASKS', 'The CoNest Runtime has reached its active task limit');
    const requestedWorkspace = realpathSync(request.workspaceRoot);
    if (requestedWorkspace !== this.current.config.workspaceRoot) {
      throw new BridgeError('WORKSPACE_DENIED', 'The requested workspace does not match the configured workspace');
    }
    const descriptor = this.current.registry.descriptor(request.capability);
    if (!descriptor) throw new BridgeError('CAPABILITY_UNAVAILABLE', `Capability ${request.capability} is not available`);
    if (!hasPermissions(descriptor.permissions, this.current.config.permissions)
      || !hasPermissions(descriptor.permissions, request.permissions)) {
      throw new BridgeError('PERMISSION_DENIED', `Capability ${request.capability} requires ${descriptor.permissions.join(', ')}`);
    }
    if (request.expectedGeneration && request.expectedGeneration !== this.current.revision) {
      throw new BridgeError('STALE_GENERATION', 'The capability catalog changed; discover capabilities again before invoking');
    }
    const expiresAt = Math.min(request.expiresAt ?? Infinity, Date.now() + this.current.config.taskTtlMs);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new BridgeError('AUTHORIZATION_EXPIRED', 'The requested task authorization has expired');
    return this.authority.issue({ ...request, workspaceRoot: requestedWorkspace }, this.current.revision, expiresAt);
  }

  release(authorization: string): boolean { return this.authority.release(authorization); }

  async invoke(request: InvokeRequest): Promise<InvokeResult> {
    if (this.closing) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime is stopping');
    const grant = this.authority.consume(request.authorization, { ...request, workspaceRoot: realpathSync(request.workspaceRoot) });
    if (grant.generation !== this.current.revision) throw new BridgeError('STALE_GENERATION', 'The authorized component generation has changed');
    if (this.tasks.has(request.taskId)) throw new BridgeError('DUPLICATE_TASK', 'The task is already running');
    const requestedWorkspace = realpathSync(request.workspaceRoot);
    if (requestedWorkspace !== this.current.config.workspaceRoot) throw new BridgeError('WORKSPACE_DENIED', 'The authorized workspace has changed');

    const generation = this.current;
    const capabilityRules = this.rules(request);
    const allowedCapabilities = Object.freeze(generation.config.components.flatMap(component => component.manifest.capabilities)
      .filter(capability => allowsCapability(capability.name, capabilityRules)).map(capability => capability.name));
    generation.refs += 1;
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const task: TaskRecord = { controller, done: completion.promise, finish: () => completion.resolve(), authorization: grant.token };
    this.tasks.set(request.taskId, task);
    const progress = (state: Progress['state'], message: string): void => {
      this.emitProgress({ callId: request.callId, state, message, at: Date.now() });
    };
    const timeout = setTimeout(() => {
      controller.abort(new BridgeError('TASK_TIMEOUT', `Task exceeded its ${generation.config.taskTtlMs}ms lifetime`));
    }, Math.max(0, grant.expiresAt - Date.now()));
    timeout.unref();
    let unresponsiveTimer: NodeJS.Timeout | undefined;
    controller.signal.addEventListener('abort', () => {
      unresponsiveTimer = setTimeout(() => this.onUnresponsive(request.taskId), generation.config.abortGraceMs);
      unresponsiveTimer.unref();
    }, { once: true });
    progress(this.scheduler.active >= generation.config.maxConcurrent ? 'queued' : 'running',
      this.scheduler.active >= generation.config.maxConcurrent ? 'Waiting for an execution slot' : 'Starting capability');

    try {
      const result = await this.scheduler.submit(controller.signal, async () => {
        progress('running', 'Capability is running');
        const invocation: Invocation = {
          callId: request.callId,
          taskId: request.taskId,
          subject: request.subject,
          memorySubject: resolveAutomaticMemorySubject(request.principal.kind === 'operator' ? { agentId: 'main' } : { agentId: request.principal.agentId, ...request.principal.requester }, 'conest')?.entityName,
          workspaceRoot: requestedWorkspace,
          permissions: request.permissions.filter(permission => generation.config.permissions.includes(permission)),
          capabilityPath: [],
          allowedCapabilities,
          signal: controller.signal,
          progress: message => progress('running', message),
        };
        const value = await generation.registry.invoke(request.capability, request.args, invocation);
        controller.signal.throwIfAborted();
        return value;
      });
      progress('completed', 'Capability completed');
      return { value: result, generation: generation.revision };
    } catch (error) {
      const effective = controller.signal.aborted ? controller.signal.reason : error;
      if (effective instanceof BridgeError && effective.code === 'CAPABILITY_DENIED') this.policyDenials++;
      progress(controller.signal.aborted ? 'cancelled' : 'failed', effective instanceof Error ? effective.message : String(effective));
      throw effective;
    } finally {
      clearTimeout(timeout);
      clearTimeout(unresponsiveTimer);
      this.tasks.delete(request.taskId);
      generation.refs -= 1;
      task.finish();
      await this.disposeRetired();
    }
  }

  cancel(taskId: string, authorization: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return this.authority.release(authorization);
    if (task.authorization !== authorization) throw new BridgeError('AUTHORIZATION_MISMATCH', 'The cancellation grant belongs to another call');
    task.controller.abort(new BridgeError('TASK_CANCELLED', 'The task was cancelled by its caller'));
    return true;
  }

  async reload(config: BridgeConfig, beforeCommit?: () => Promise<void>): Promise<RuntimeStatus> {
    if (this.reloading) throw new BridgeError('RELOAD_BUSY', 'Another component change is already being prepared');
    this.reloading = this.performReload(structuredClone(config), beforeCommit);
    try {
      const status = await this.reloading;
      this.lastReloadError = undefined;
      return { ...status, lastReloadError: undefined };
    } catch (error) {
      this.lastReloadError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.reloading = undefined; }
  }

  private async performReload(config: BridgeConfig, beforeCommit?: () => Promise<void>): Promise<RuntimeStatus> {
    if (this.closing) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime is stopping');
    if (config.workspaceRoot !== this.current.config.workspaceRoot) {
      throw new BridgeError('WORKSPACE_RESTART_REQUIRED', 'Changing workspaceRoot requires an OpenClaw plugin service restart');
    }
    if (config.memoryFilePath !== this.current.config.memoryFilePath) throw new BridgeError('MEMORY_RESTART_REQUIRED', 'Changing memoryFilePath requires a worker restart');
    await this.disposeRetired();
    if (this.retired.length >= config.maxRetiredGenerations) {
      throw new BridgeError('RELOAD_BUSY', 'Too many previous generations still have active tasks');
    }
    const next = await this.loader.prepare(config, graphRevision(config), this.current);
    try {
      assertAcceptableChange(this.current, next);
      if (this.closing) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime stopped while the component change was being prepared');
      await beforeCommit?.();
    } catch (error) { await next.dispose(); throw error; }
    const previous = this.current;
    this.current = next;
    if (!isDeepStrictEqual(previous.config.capabilityPolicy, next.config.capabilityPolicy) || !isDeepStrictEqual(previous.config.permissions, next.config.permissions)) {
      this.authority.close();
      for (const task of this.tasks.values()) task.controller.abort(new BridgeError('POLICY_CHANGED', 'The worker authorization policy changed; start a new task'));
    }
    this.scheduler.configure(config.maxConcurrent, config.maxQueued);
    previous.retired = true;
    this.retired.push(previous);
    await this.disposeRetired();
    return this.status();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    this.authority.close();
    await this.reloading?.catch(() => {});
    const records = [...this.tasks.values()];
    for (const task of records) task.controller.abort(new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime is stopping'));
    await Promise.allSettled(records.map(task => task.done));
    const disposal = await Promise.allSettled([this.current.dispose(), ...this.retired.map(generation => generation.dispose())]);
    this.retired.length = 0;
    const errors = disposal.filter(result => result.status === 'rejected').map(result => result.reason);
    try { await this.loader.close(); } catch (error) { errors.push(error); }
    errors.push(...this.loader.cleanupErrors);
    if (errors.length) throw new AggregateError(errors, 'CoNest Runtime shutdown cleanup failed');
  }

  private async disposeRetired(): Promise<void> {
    const draining: RuntimeGeneration[] = [];
    for (let index = this.retired.length - 1; index >= 0; index -= 1) {
      const generation = this.retired[index]!;
      if (generation.refs > 0) continue;
      this.retired.splice(index, 1);
      draining.push(generation);
    }
    // Remove and enqueue the whole batch before yielding. Another finishing call
    // may retire an earlier graph while native asynchronous disposal is in flight.
    await Promise.all(draining.map(async generation => {
      try { await generation.dispose(); } catch (error) {
        // The new generation is already committed; report cleanup failure without claiming rollback.
        this.cleanupErrors.push(`${generation.revision}: ${error instanceof Error ? error.message : String(error)}`);
        if (this.cleanupErrors.length > 16) this.cleanupErrors.shift();
      }
    }));
  }
}

function graphRevision(config: BridgeConfig): string {
  // A configuration reverted to earlier bytes is still a different runtime graph.
  // Old grants/catalogs must not become current again (including after worker restart).
  return `${revision(config)}-${randomUUID()}`;
}

function assertAcceptableChange(previous: RuntimeGeneration, next: RuntimeGeneration): void {
  const specs = new Map(next.config.components.map(component => [component.manifest.id, component]));
  const intentionallyRemoved = new Set(previous.config.components.filter(component => component.enabled
    && !specs.get(component.manifest.id)?.enabled).map(component => component.manifest.id));
  const affectedByRemoval = (id: string, visited = new Set<string>()): boolean => {
    if (intentionallyRemoved.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return Object.keys(specs.get(id)?.manifest.requires ?? {}).some(dependency => affectedByRemoval(dependency, visited));
  };
  for (const state of next.statuses) {
    if (state.state !== 'blocked') continue;
    const wasReady = previous.statuses.some(component => component.id === state.id && component.state === 'ready');
    if (state.reasonCode === 'activation' || state.reasonCode === 'cycle' || (wasReady && !affectedByRemoval(state.id))) {
      throw new BridgeError('UPGRADE_REJECTED', `Component change rejected; the previous generation remains active: ${state.id}: ${state.reason}`);
    }
  }
}
