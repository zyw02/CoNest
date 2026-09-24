import type { Progress } from './types.js';

export type WireRequest = {
  id: string;
  method: 'status' | 'catalog' | 'authorize' | 'release' | 'invoke' | 'cancel' | 'reload' | 'manage' | 'shutdown' | 'extension' | 'extension.cancel' | 'callback';
  params?: unknown;
};
export type WireResponse = {
  id: string;
  ok: true;
  result: unknown;
} | {
  id: string;
  ok: false;
  error: { code: string; message: string };
};
export type WireEvent = { event: 'progress'; data: Progress };

export function isWireResponse(value: unknown): value is WireResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.ok === 'boolean'
    && (record.ok ? 'result' in record : isWireError(record.error));
}

export function isWireEvent(value: unknown): value is WireEvent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.event !== 'progress' || !record.data || typeof record.data !== 'object') return false;
  const data = record.data as Record<string, unknown>;
  return typeof data.callId === 'string' && typeof data.state === 'string'
    && ['queued', 'running', 'completed', 'cancelled', 'failed'].includes(data.state)
    && typeof data.message === 'string' && typeof data.at === 'number';
}

function isWireError(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && typeof (value as Record<string, unknown>).code === 'string'
    && typeof (value as Record<string, unknown>).message === 'string';
}
