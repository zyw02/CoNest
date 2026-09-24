import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BridgeError } from './types.js';
import type { BridgeConfig } from './types.js';
import type { HostCallback } from './extension-protocol.js';
import type { CordisBridgeHost } from './studio/cordis-bridge-host.js';

/** Optional DSH support pack, owned by the Host rather than a plugin Context. */
export class ExtensionHost {
  private host?: Promise<CordisBridgeHost>;
  private closing = false;
  private readonly calls = new Map<string, AbortController>();
  private readonly callbacks = new Map<string, { channel: string; resolve(value: any): void; reject(error: unknown): void }>();

  constructor(private readonly config: BridgeConfig, private readonly send: (message: HostCallback) => void) {}

  async call(input: any): Promise<unknown> {
    if (this.closing) throw new BridgeError('BRIDGE_STOPPING', 'CoNest Host is stopping');
    if (!input || typeof input.channel !== 'string' || this.calls.has(input.channel) || this.calls.size >= this.config.maxTasks) {
      throw new BridgeError('INVALID_REQUEST', 'Invalid or excessive extension calls');
    }
    const allowed = ['start', 'status', 'execute', 'observeRead', 'runHarnessAgent', 'runAgent', 'endHarnessSession'];
    if (!allowed.includes(input.operation)) throw new BridgeError('METHOD_NOT_FOUND', 'Unknown support pack operation');
    const setup = input.setup;
    if (!setup || path.resolve(setup.workspaceRoot ?? '') !== this.config.workspaceRoot) {
      throw new BridgeError('PERMISSION_DENIED', 'Support pack must use the Host workspace');
    }
    const lifetime = new AbortController();
    this.calls.set(input.channel, lifetime);
    const deadline = setTimeout(() => lifetime.abort(new BridgeError('TASK_TIMEOUT', 'Support pack call exceeded its deadline')), this.config.taskTtlMs);
    let grace: NodeJS.Timeout | undefined;
    lifetime.signal.addEventListener('abort', () => {
      for (const [id, pending] of this.callbacks) if (pending.channel === input.channel) {
        this.callbacks.delete(id); pending.reject(lifetime.signal.reason);
      }
      grace = setTimeout(() => {
        process.stderr.write('CoNest support pack ignored cancellation; terminating owned Host\n');
        process.exit(70);
      }, this.config.abortGraceMs);
    }, { once: true });
    const callback = (name: string, args: unknown): Promise<any> => {
      lifetime.signal.throwIfAborted();
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        this.callbacks.set(id, { channel: input.channel, resolve, reject });
        try { this.send({ event: 'host.callback', data: { channel: input.channel, id, name, args } }); }
        catch (error) { this.callbacks.delete(id); reject(error); }
      });
    };
    try {
      this.host ??= import('./studio/host-runtime.js').then(module => new module.CordisBridgeHost());
      const host = await this.host;
      await host.start(setup);
      lifetime.signal.throwIfAborted();
      const args = input.args ?? {};
      switch (input.operation) {
        case 'start': case 'status': return { state: host.status(), pid: process.pid, parentPid: process.ppid };
        case 'endHarnessSession': await host.endHarnessSession(args); return null;
        case 'observeRead': await host.observeRead(args.receipt, args.sessionKey, lifetime.signal); return null;
        case 'execute': return await host.execute(args.callId, args.name, args.params, args.sessionKey, lifetime.signal);
        case 'runAgent': case 'runHarnessAgent': {
          const options = { ...args, signal: lifetime.signal,
            onEvent: (event: unknown) => callback('event', event),
            approvalRequester: (request: unknown) => callback('approval', request),
            ...(args.hostTools ? { hostTools: args.hostTools.map((tool: any) => ({ ...tool,
              execute: (callId: string, params: unknown) => callback('tool', { name: tool.name, callId, args: params }),
            })) } : {}),
          };
          return input.operation === 'runAgent' ? await host.runAgent(options) : await host.runHarnessAgent(options);
        }
      }
    } catch (error) {
      if (error instanceof Error && 'kind' in error) throw new BridgeError(`DSH_${String(error.kind).toUpperCase()}`, error.message);
      throw error;
    } finally {
      clearTimeout(deadline); clearTimeout(grace);
      this.calls.delete(input.channel);
      for (const [id, pending] of this.callbacks) if (pending.channel === input.channel) {
        this.callbacks.delete(id); pending.reject(new BridgeError('CALL_ENDED', 'The support pack call ended'));
      }
    }
  }

  reply(input: any): void {
    const pending = this.callbacks.get(input?.callbackId);
    if (!pending || pending.channel !== input.channel) throw new BridgeError('CALLBACK_EXPIRED', 'No matching live callback');
    this.callbacks.delete(input.callbackId);
    if (input.ok === true) pending.resolve(input.result);
    else pending.reject(new BridgeError(input.error?.code ?? 'CALLBACK_FAILED', String(input.error?.message ?? 'Host callback failed')));
  }

  cancel(channel: string): void { this.calls.get(channel)?.abort(new BridgeError('TASK_CANCELLED', 'Parent call cancelled')); }

  async close(): Promise<void> {
    this.closing = true;
    for (const channel of this.calls.keys()) this.cancel(channel);
    if (this.host) await (await this.host).stop();
  }
}
