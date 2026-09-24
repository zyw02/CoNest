import { randomUUID } from 'node:crypto';
import { BridgeError, type Permission, type Principal, type CapabilityRule } from './types.js';
import { isDeepStrictEqual } from 'node:util';

export type CallScope = {
  capability: string;
  taskId: string;
  callId: string;
  subject: string;
  parentTaskId?: string;
  workspaceRoot: string;
  permissions: Permission[];
  principal: Principal;
  capabilityCeiling?: CapabilityRule;
};
export type AuthorizationRequest = CallScope & { expectedGeneration?: string; expiresAt?: number };
export type CallGrant = { token: string; expiresAt: number; generation: string };
type Record = CallGrant & { scope: CallScope; timer: NodeJS.Timeout };

/** One-use call grants issued only through the adapter's private process pipe. */
export class CallAuthority {
  private readonly issued = new Map<string, Record>();

  get size(): number { return this.issued.size; }

  hasTask(taskId: string): boolean {
    return [...this.issued.values()].some(record => record.scope.taskId === taskId);
  }

  issue(scope: CallScope, generation: string, expiresAt: number): CallGrant {
    const token = randomUUID();
    const timer = setTimeout(() => this.release(token), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    this.issued.set(token, { token, generation, expiresAt, scope: structuredClone(scope), timer });
    return { token, generation, expiresAt };
  }

  consume(token: string, scope: CallScope): CallGrant {
    const record = this.issued.get(token);
    if (!record) throw new BridgeError('AUTHORIZATION_INVALID', 'The call grant is unknown, expired, revoked, or already used');
    this.release(token);
    if (record.expiresAt <= Date.now()) throw new BridgeError('AUTHORIZATION_EXPIRED', 'The call authorization has expired');
    for (const key of ['taskId', 'callId', 'subject', 'parentTaskId', 'workspaceRoot', 'capability'] as const) {
      if (record.scope[key] !== scope[key]) throw new BridgeError('AUTHORIZATION_MISMATCH', `The call grant does not authorize this ${key}`);
    }
    if (scope.permissions.some(permission => !record.scope.permissions.includes(permission))) {
      throw new BridgeError('AUTHORIZATION_MISMATCH', 'The call grant does not authorize these permissions');
    }
    if (!isDeepStrictEqual(scope.principal, record.scope.principal) || !isDeepStrictEqual(scope.capabilityCeiling ?? {}, record.scope.capabilityCeiling ?? {})) {
      throw new BridgeError('AUTHORIZATION_MISMATCH', 'The call grant does not authorize this principal or capability ceiling');
    }
    return { token, generation: record.generation, expiresAt: record.expiresAt };
  }

  release(token: string): boolean {
    const record = this.issued.get(token);
    if (!record) return false;
    clearTimeout(record.timer);
    this.issued.delete(token);
    return true;
  }

  close(): void {
    for (const token of this.issued.keys()) this.release(token);
  }
}
