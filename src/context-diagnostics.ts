/** Fixed-cardinality, payload-free diagnostics shared by all registries for one runtime. */
export const CONTEXT_OUTCOMES = ['contributed', 'empty', 'denied', 'unavailable', 'stale', 'timeout', 'cancelled', 'invalid', 'busy', 'failed'] as const;
export type ContextOutcome = typeof CONTEXT_OUTCOMES[number];
const diagnosticCodes = ['CONTEXT_CLOSED', 'CONTEXT_BUSY', 'CONTEXT_IDENTITY_MISSING', 'CONTEXT_ENDED', 'CONTEXT_TIMEOUT', 'CONTEXT_DENIED',
  'TASK_ENDED', 'TASK_CANCELLED', 'TASK_TIMEOUT', 'SESSION_ENDED', 'BRIDGE_STOPPING', 'POLICY_CHANGED', 'HOST_POLICY_UNAVAILABLE',
  'CAPABILITY_DENIED', 'PERMISSION_DENIED', 'WORKSPACE_DENIED', 'STALE_GENERATION', 'AUTHORIZATION_EXPIRED', 'CAPABILITY_UNAVAILABLE',
  'BRIDGE_UNAVAILABLE', 'BRIDGE_EXITED', 'RESTART_LIMIT', 'UNKNOWN'] as const;
export type ContextDiagnosticCode = typeof diagnosticCodes[number];
export type ContextDiagnosticsSnapshot = {
  active: number; transports: number; counts: Record<ContextOutcome, number>;
  last?: { outcome: ContextOutcome; durationMs: number; at: number; code?: ContextDiagnosticCode };
};

export class ContextDiagnostics {
  private active = 0;
  private transports = 0;
  private readonly counts = Object.fromEntries(CONTEXT_OUTCOMES.map(outcome => [outcome, 0])) as Record<ContextOutcome, number>;
  private last?: ContextDiagnosticsSnapshot['last'];

  begin(): void { this.active++; }
  end(): void { this.active--; }
  beginTransport(): void { this.transports++; }
  endTransport(): void { this.transports--; }
  record(outcome: ContextOutcome, durationMs: number, code?: ContextDiagnosticCode): void {
    this.counts[outcome] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[outcome] + 1);
    this.last = { outcome, durationMs: Math.max(0, Math.round(durationMs)), at: Date.now(), ...(code ? { code } : {}) };
  }
  snapshot(): ContextDiagnosticsSnapshot {
    return { active: this.active, transports: this.transports, counts: { ...this.counts }, ...(this.last ? { last: { ...this.last } } : {}) };
  }
}

export function contextErrorCode(error: unknown): ContextDiagnosticCode {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && diagnosticCodes.includes(code as ContextDiagnosticCode) ? code as ContextDiagnosticCode : 'UNKNOWN';
}

export function contextErrorOutcome(error: unknown): ContextOutcome {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code !== 'string') return 'failed';
  if (['CONTEXT_TIMEOUT', 'TASK_TIMEOUT', 'AUTHORIZATION_EXPIRED'].includes(String(code))) return 'timeout';
  if (['CONTEXT_DENIED', 'CAPABILITY_DENIED', 'PERMISSION_DENIED', 'WORKSPACE_DENIED', 'HOST_POLICY_UNAVAILABLE', 'IDENTITY_UNAVAILABLE'].includes(String(code))) return 'denied';
  if (['TASK_ENDED', 'TASK_CANCELLED', 'SESSION_ENDED', 'BRIDGE_STOPPING', 'CONTEXT_ENDED', 'POLICY_CHANGED'].includes(String(code))) return 'cancelled';
  if (code === 'STALE_GENERATION') return 'stale';
  if (['CAPABILITY_UNAVAILABLE', 'BRIDGE_UNAVAILABLE', 'BRIDGE_EXITED', 'RESTART_LIMIT'].includes(String(code))) return 'unavailable';
  return 'failed';
}
