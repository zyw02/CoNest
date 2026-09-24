// OpenClaw 2026.9.x ships this public JS export without its declaration file.
// Keep the narrow consumed contract at the adapter boundary.
declare module 'openclaw/plugin-sdk/session-transcript-runtime' {
  import type { AgentHarnessAttemptResult } from 'openclaw/plugin-sdk/agent-harness-runtime';
  export type TranscriptEntryAnchor = NonNullable<AgentHarnessAttemptResult['terminalAnchor']>;
  export function appendSessionTranscriptMessageByIdentityStrict<T>(params: {
    agentId?: string; sessionId: string; sessionKey: string; storePath: string;
    config?: unknown; cwd?: string; eventId: string; idempotencyLookup: 'scan'; message: T;
    prepareMessageAfterIdempotencyCheck: () => T | undefined;
  }): Promise<{ kind: 'rejected' } | { kind: 'suppressed' } | {
    kind: 'appended'; result: { appended: boolean; anchor: TranscriptEntryAnchor };
  }>;
  export function publishSessionTranscriptUpdateByIdentity(params: {
    agentId?: string; sessionId: string; sessionKey: string; storePath: string;
  }): Promise<unknown>;
}
