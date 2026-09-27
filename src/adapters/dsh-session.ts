import type { ContentBlock } from './dsh-llm.js';
export { Session, SessionId, SESSION_FORMAT_VERSION, default as SessionStore } from '@deepseek-ai/dsh-session';
export type { SessionEvent } from '@deepseek-ai/dsh-session';

import { Session, SESSION_FORMAT_VERSION, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session';

type CompatibleSession = {
  readonly seq: number;
  readonly events?: readonly SessionEvent[];
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[];
};

/** Read a stable event suffix across the pre-0.1.2 and current Session APIs. */
export function sessionEventsSince(session: Session, fromSeq: number): SessionEvent[] {
  const compatible = session as unknown as CompatibleSession;
  if (typeof compatible.snapshotEvents === 'function') return [...compatible.snapshotEvents(fromSeq)];
  return [...(compatible.events?.slice(fromSeq) ?? [])];
}

/** Create the detached tool-owner session used by non-Agent native tools. */
export function createDetachedSession(id: SessionId, cwd: string): Session {
  const create = Session.create as unknown as (
    sessionId: SessionId,
    seed: readonly SessionEvent[],
    header: Record<string, unknown>,
  ) => Session;
  return create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  });
}

type SessionToolResult = { toolCallId: string; content: ContentBlock[]; isError?: boolean };

function isLegacyToolResult(block: unknown): block is SessionToolResult & { type: 'tool-result' } {
  if (!block || typeof block !== 'object') return false;
  return Reflect.get(block, 'type') === 'tool-result'
    && typeof Reflect.get(block, 'toolCallId') === 'string' && Array.isArray(Reflect.get(block, 'content'));
}

/** Normalize block-based results and the newer role=tool message contract. */
export function sessionToolResults(event: Extract<SessionEvent, { type: 'tool/result' }>): SessionToolResult[] {
  const message = event.data.message;
  if ('toolCallId' in message && typeof message.toolCallId === 'string') {
    return [{ toolCallId: message.toolCallId, content: message.content,
      isError: 'isError' in message && message.isError === true }];
  }
  const blocks: readonly unknown[] = message.content;
  return blocks.filter(isLegacyToolResult).map(block => ({
    toolCallId: block.toolCallId, content: block.content, isError: block.isError === true,
  }));
}
