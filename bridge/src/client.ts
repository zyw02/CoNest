import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { JsonObject, Permission, Progress, RuntimeStatus, CatalogRequest, CapabilityCatalog, Principal, CapabilityRule } from './types.js';
import type { CallGrant } from './authorization.js';
import type { ComponentOperation } from './management.js';
import { BridgeError, HOST_VERSION, PROTOCOL_VERSION } from './types.js';
import { isWireEvent, isWireResponse } from './protocol.js';
import { readFrames } from './framing.js';
import { executionEnvironment } from './environment.js';
import type { ExtensionCall, HostCallback } from './extension-protocol.js';
import { errorData } from './types.js';

type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

export type ClientOptions = {
  workerFile: string;
  configFile?: string;
  workspaceRoot?: string;
  memoryFilePath?: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxPayloadBytes?: number;
  onLog?(level: 'info' | 'warn', message: string): void;
  onFailure?(message: string): void;
};

export type ClientInvocation = {
  capability: string;
  args: JsonObject;
  taskId: string;
  callId: string;
  subject: string;
  parentTaskId?: string;
  workspaceRoot: string;
  permissions: Permission[];
  principal: Principal;
  capabilityCeiling?: CapabilityRule;
  expectedGeneration?: string;
  expiresAt?: number;
  signal?: AbortSignal;
  onProgress?(progress: Progress): void;
  /** Adapter-only: optional background context must not populate user-facing progress snapshots. */
  recordProgress?: boolean;
};

/** One private pipe, one process owner, and no automatic replay of failed calls. */
export class BridgeClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly progress = new Map<string, (progress: Progress) => void>();
  private state: 'stopped' | 'starting' | 'ready' | 'failed' = 'stopped';
  private failure: string | undefined;
  private stopping: Promise<void> | undefined;
  private readonly extensionCalls = new Map<string, { callbacks: NonNullable<ExtensionCall['callbacks']>; lifetime: AbortController; child: ChildProcessWithoutNullStreams }>();

  constructor(private readonly options: ClientOptions) {}

  getState(): { state: string; failure?: string } {
    return { state: this.state, ...(this.failure ? { failure: this.failure } : {}) };
  }

  async start(): Promise<RuntimeStatus> {
    if (this.stopping) await this.stopping;
    if (this.state === 'ready') return await this.status();
    if (this.state === 'starting') throw new BridgeError('BRIDGE_STARTING', 'The CoNest Runtime is already starting');
    if (this.child) await this.stop();
    this.state = 'starting';
    this.failure = undefined;
    const args = [this.options.workerFile, 'serve'];
    if (this.options.configFile) args.push('--config', this.options.configFile);
    else if (this.options.workspaceRoot) args.push('--workspace', this.options.workspaceRoot);
    if (this.options.memoryFilePath) args.push('--memory-file', this.options.memoryFilePath);
    const child = spawn(process.execPath, args, {
      cwd: this.options.workspaceRoot ?? process.cwd(),
      env: executionEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    readFrames(child.stdout, () => 2_000_000,
      line => { if (this.child === child) this.receive(line); },
      error => this.fail(child, error));
    const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });
    errors.on('line', line => this.options.onLog?.(line.startsWith('CoNest Host startup:') ? 'info' : 'warn', line));
    child.stdin.on('error', error => this.fail(child, error));
    child.once('error', error => this.fail(child, error));
    child.once('exit', (code, signal) => {
      errors.close();
      if (this.child !== child) return;
      const message = `CoNest Runtime process exited${signal ? ` from ${signal}` : ` with code ${code ?? 'unknown'}`}; an interrupted call was not replayed`;
      this.rejectPending(new BridgeError('BRIDGE_EXITED', message));
      this.child = undefined;
      if (this.stopping) this.state = 'stopped';
      else {
        this.state = 'failed';
        this.failure = message;
        this.options.onFailure?.(message);
      }
    });
    try {
      const status = await this.request<RuntimeStatus>('status', undefined, this.options.startupTimeoutMs);
      if (status.protocol !== PROTOCOL_VERSION) throw new BridgeError('PROTOCOL_MISMATCH', `CoNest Runtime protocol ${status.protocol} does not match ${PROTOCOL_VERSION}`);
      if (status.hostVersion !== HOST_VERSION) throw new BridgeError('HOST_VERSION_MISMATCH', `CoNest Runtime targets OpenClaw ${status.hostVersion}, expected ${HOST_VERSION}`);
      this.state = 'ready';
      return status;
    } catch (error) {
      await this.stop();
      this.state = 'failed';
      this.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async status(): Promise<RuntimeStatus> { return await this.request('status', undefined, 3_000); }
  async catalog(request: CatalogRequest): Promise<CapabilityCatalog> { return await this.request('catalog', request, 3_000); }

  async invoke(input: ClientInvocation): Promise<{ value: unknown; generation: string }> {
    if (this.state !== 'ready') throw new BridgeError('BRIDGE_UNAVAILABLE', `The CoNest Runtime is ${this.state}${this.failure ? `: ${this.failure}` : ''}`);
    input.signal?.throwIfAborted();
    const scope = {
      capability: input.capability,
      taskId: input.taskId,
      callId: input.callId,
      subject: input.subject,
      principal: input.principal,
      capabilityCeiling: input.capabilityCeiling,
      parentTaskId: input.parentTaskId,
      workspaceRoot: input.workspaceRoot,
      permissions: input.permissions,
    };
    const grant = await this.request<CallGrant>('authorize', {
      ...scope, expectedGeneration: input.expectedGeneration, expiresAt: input.expiresAt,
    }, 3_000);
    if (input.onProgress) this.progress.set(input.callId, input.onProgress);
    try {
      input.signal?.throwIfAborted();
      return await this.request('invoke', {
        ...scope, args: input.args, authorization: grant.token,
      }, Math.max(100, grant.expiresAt - Date.now()) + 15_000, input.signal, () => {
        void this.request('cancel', { taskId: input.taskId, authorization: grant.token }, 1_000).catch(() => {});
      });
    } finally {
      this.progress.delete(input.callId);
      if (this.child) void this.request('release', { authorization: grant.token }, 1_000).catch(() => {});
    }
  }

  async reload(): Promise<RuntimeStatus> { return await this.request('reload', {}, 120_000); }
  async manage(operation: ComponentOperation): Promise<RuntimeStatus> { return await this.request('manage', operation, 120_000); }

  async extension<T>(call: ExtensionCall): Promise<T> {
    const channel = randomUUID();
    const lifetime = new AbortController();
    const child = this.child;
    if (!child || this.state !== 'ready') throw new BridgeError('BRIDGE_UNAVAILABLE', 'CoNest Host is not ready');
    const signal = call.signal ? AbortSignal.any([call.signal, lifetime.signal]) : lifetime.signal;
    this.extensionCalls.set(channel, { callbacks: call.callbacks ?? {}, lifetime, child });
    try {
      return await this.request<T>('extension', { channel, operation: call.operation, setup: call.setup, args: call.args },
        call.timeoutMs ?? 120_000, signal, () => {
          void this.request('extension.cancel', { channel }, 1_000).catch(() => {});
        });
    } finally {
      this.extensionCalls.delete(channel);
      lifetime.abort(new BridgeError('CALL_ENDED', 'The parent Host call ended'));
    }
  }

  private async callback(message: HostCallback): Promise<void> {
    const { channel, id, name, args } = message.data;
    const owner = this.extensionCalls.get(channel);
    if (!owner || owner.child !== this.child) return;
    let reply: object;
    try {
      owner.lifetime.signal.throwIfAborted();
      const handler = Object.hasOwn(owner.callbacks, name) ? owner.callbacks[name] : undefined;
      if (!handler) throw new BridgeError('CALLBACK_DENIED', `No admitted ${name} callback`);
      const result = await handler(args, owner.lifetime.signal);
      owner.lifetime.signal.throwIfAborted();
      reply = { channel, callbackId: id, ok: true, result: result ?? null };
    } catch (error) { reply = { channel, callbackId: id, ok: false, error: errorData(error) }; }
    // Never deliver an old process's callback result to a replacement process.
    if (this.child !== owner.child || this.extensionCalls.get(channel) !== owner) return;
    await this.request('callback', reply, 3_000).catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    const child = this.child;
    if (!child) { this.state = 'stopped'; return; }
    this.stopping = this.stopChild(child);
    try { await this.stopping; } finally { this.stopping = undefined; }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) resolve();
      else child.once('exit', () => resolve());
    });
    try {
      await this.request('shutdown', {}, Math.min(this.options.shutdownTimeoutMs, 1_000));
      child.stdin.end();
    } catch { /* The owning client still reaps a child whose pipe has already failed. */ }
    if (!await waitForExit(exited, this.options.shutdownTimeoutMs)) {
      killOwnedProcess(child, 'SIGTERM');
      if (!await waitForExit(exited, this.options.shutdownTimeoutMs)) {
        killOwnedProcess(child, 'SIGKILL');
        await exited;
      }
    }
    this.rejectPending(new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime service stopped'));
    if (this.child === child) this.child = undefined;
    this.state = 'stopped';
  }

  private request<T>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new BridgeError('BRIDGE_UNAVAILABLE', 'The CoNest Runtime process is not running'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = randomUUID();
    let frame: string;
    try {
      frame = `${JSON.stringify({ id, method, params })}\n`;
      if (Buffer.byteLength(frame) > (this.options.maxPayloadBytes ?? 256_000)) throw new BridgeError('PAYLOAD_TOO_LARGE', 'The request exceeds the configured payload limit');
    } catch (error) { return Promise.reject(error); }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removePending(id);
        onAbort?.();
        reject(new BridgeError('BRIDGE_TIMEOUT', `${method} did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      const pending: Pending = { resolve: value => resolve(value as T), reject, timer, signal };
      if (signal) {
        pending.abort = () => {
          this.removePending(id);
          onAbort?.();
          reject(signal.reason ?? new BridgeError('TASK_CANCELLED', 'The task was cancelled'));
        };
        signal.addEventListener('abort', pending.abort, { once: true });
      }
      this.pending.set(id, pending);
      child.stdin.write(frame, error => {
        if (!error) return;
        this.removePending(id)?.reject(new BridgeError('BRIDGE_DISCONNECTED', error.message));
      });
    });
  }

  private removePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    return pending;
  }

  private receive(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      this.options.onLog?.('warn', 'CoNest Runtime process emitted a malformed response');
      return;
    }
    if (message && typeof message === 'object' && (message as HostCallback).event === 'host.callback') {
      const data = (message as HostCallback).data;
      if (data && [data.channel, data.id, data.name].every(value => typeof value === 'string')) {
        void this.callback(message as HostCallback).catch(error => this.options.onLog?.('warn', String(error)));
      }
      return;
    }
    if (isWireEvent(message)) {
      try { this.progress.get(message.data.callId)?.(message.data); } catch (error) {
        this.options.onLog?.('warn', `Progress observer failed: ${String(error)}`);
      }
      return;
    }
    if (!isWireResponse(message)) {
      this.options.onLog?.('warn', 'CoNest Runtime process emitted an unknown response');
      return;
    }
    const pending = this.removePending(message.id);
    if (!pending) return;
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new BridgeError(message.error.code, message.error.message));
  }

  private rejectPending(error: Error): void {
    for (const owner of this.extensionCalls.values()) owner.lifetime.abort(error);
    this.extensionCalls.clear();
    for (const id of this.pending.keys()) this.removePending(id)?.reject(error);
    this.progress.clear();
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.rejectPending(new BridgeError('BRIDGE_DISCONNECTED', error.message));
    this.failure = error.message;
    this.state = 'failed';
    killOwnedProcess(child, 'SIGTERM');
  }
}

function killOwnedProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally { clearTimeout(timer); }
}
