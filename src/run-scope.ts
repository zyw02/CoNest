import { BridgeError, type Principal } from './types.js';

export type HostSession = { sessionId?: string; agentId?: string };
type Binding = { runId?: string; principal?: Principal; session: HostSession; controller: AbortController; timer: NodeJS.Timeout; consumed: boolean };

/** Bind adapter calls to host lifecycle events without exposing authority in model arguments. */
export class RunScopes {
  private readonly calls = new Map<string, Binding>();
  private readonly restrictions = new Map<string, { deny: Set<string>; timer: NodeJS.Timeout; session: HostSession }>();

  constructor(private readonly lifetimeMs: number, private readonly limit: number) {}

  observe(callId: string, runId?: string, signal?: AbortSignal, principal?: Principal, session: HostSession = {}): void {
    const existing = this.calls.get(callId);
    if (existing) { existing.session = mergeSession(existing.session, session); return; }
    if (this.calls.size >= this.limit) throw new BridgeError('TOO_MANY_TASKS', 'The adapter task binding limit has been reached');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new BridgeError('TASK_CANCELLED', 'The host cancelled the call'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new BridgeError('TASK_TIMEOUT', 'The host call binding expired'));
      signal?.removeEventListener('abort', abort);
      this.calls.delete(callId);
    }, this.lifetimeMs);
    timer.unref();
    controller.signal.addEventListener('abort', () => signal?.removeEventListener('abort', abort), { once: true });
    this.calls.set(callId, { runId, principal: principal ? structuredClone(principal) : undefined, session: mergeSession({}, session), controller, timer, consumed: false });
  }

  claim(callId: string, signal?: AbortSignal, session?: HostSession): { runId?: string; principal?: Principal; signal: AbortSignal } {
    this.observe(callId, undefined, signal, undefined, session);
    const binding = this.calls.get(callId)!;
    binding.controller.signal.throwIfAborted();
    if (binding.consumed) throw new BridgeError('CALL_ALREADY_USED', 'This host call has already consumed its execution authority');
    binding.consumed = true;
    return { runId: binding.runId, principal: binding.principal, signal: signal ? AbortSignal.any([signal, binding.controller.signal]) : binding.controller.signal };
  }

  restrictRun(runId: string, denied: string[], session: HostSession = {}): void {
    let record = this.restrictions.get(runId);
    if (!record) {
      if (this.restrictions.size >= this.limit) throw new BridgeError('TOO_MANY_TASKS', 'The host policy snapshot limit has been reached');
      const timer = setTimeout(() => this.restrictions.delete(runId), this.lifetimeMs);
      timer.unref();
      record = { deny: new Set(), timer, session: {} };
      this.restrictions.set(runId, record);
    }
    record.session = mergeSession(record.session, session);
    for (const name of denied) record.deny.add(name);
  }

  runDenials(runId?: string): string[] {
    if (!runId) return [];
    const record = this.restrictions.get(runId);
    if (!record) throw new BridgeError('HOST_POLICY_UNAVAILABLE', 'The owning run has no current finalized tool-policy snapshot; enable the plugin conversation hook permission and start a new supported OpenClaw run');
    return [...record.deny];
  }

  endCall(callId: string): void {
    this.calls.get(callId)?.controller.abort(new BridgeError('TASK_ENDED', 'The host call ended'));
  }

  endRun(runId: string): void {
    clearTimeout(this.restrictions.get(runId)?.timer);
    this.restrictions.delete(runId);
    for (const binding of this.calls.values()) if (binding.runId === runId) binding.controller.abort(new BridgeError('TASK_ENDED', 'The owning OpenClaw run ended'));
  }

  /** A session key can be reused after reset. Never use it to cancel another session ID. */
  endSession(session: HostSession): void {
    if (!session.sessionId) return;
    const matches = (bound: HostSession) => bound.sessionId === session.sessionId
      && (!session.agentId || !bound.agentId || bound.agentId === session.agentId);
    for (const [runId, record] of this.restrictions) if (matches(record.session)) this.endRun(runId);
    for (const binding of this.calls.values()) if (matches(binding.session)) {
      binding.controller.abort(new BridgeError('SESSION_ENDED', 'The owning OpenClaw session ended'));
    }
  }

  close(): void {
    for (const binding of this.calls.values()) {
      clearTimeout(binding.timer);
      binding.controller.abort(new BridgeError('BRIDGE_STOPPING', 'The adapter is stopping'));
    }
    this.calls.clear();
    for (const record of this.restrictions.values()) clearTimeout(record.timer);
    this.restrictions.clear();
  }
}

function mergeSession(bound: HostSession, next: HostSession): HostSession {
  for (const key of ['sessionId', 'agentId'] as const) {
    if (bound[key] && next[key] && bound[key] !== next[key]) throw new BridgeError('SESSION_MISMATCH', 'Host call/run session identity changed');
  }
  return { sessionId: bound.sessionId ?? next.sessionId, agentId: bound.agentId ?? next.agentId };
}
