import path from 'node:path';
import * as transcript from 'openclaw/plugin-sdk/session-transcript-runtime';
import * as harness from 'openclaw/plugin-sdk/agent-harness-runtime';
import * as sessions from 'openclaw/plugin-sdk/session-store-runtime';

type Append = typeof transcript.appendSessionTranscriptMessageByIdentityStrict;
type AppendParams = Parameters<Append>[0];
type Identity = Pick<AppendParams, 'agentId' | 'sessionId' | 'sessionKey' | 'storePath'>;
// These public V1 exports were retired in V2; keep their contract local.
type LegacyAppend = (params: {
  transcriptPath: string; sessionId: string; config?: unknown; cwd?: string;
  message: unknown; idempotencyLookup: 'scan'; prepareMessageAfterIdempotencyCheck: () => unknown;
}) => Promise<{ appended: boolean; messageId: string } | undefined>;
type LegacyResolve = (id: string, entry: object, options: { agentId?: string; sessionsDir: string }) => string;

function legacyTarget(params: Identity): string | undefined {
  const entry = sessions.getSessionEntry({ ...params, readConsistency: 'latest' });
  if (entry?.sessionId !== params.sessionId) return undefined;
  const resolve = Reflect.get(sessions, 'resolveSessionFilePath') as LegacyResolve;
  return resolve(params.sessionId, entry, { agentId: params.agentId, sessionsDir: path.dirname(params.storePath) });
}

export const appendSessionTranscriptMessageByIdentityStrict: Append = async params => {
  if (typeof transcript.appendSessionTranscriptMessageByIdentityStrict === 'function') return transcript.appendSessionTranscriptMessageByIdentityStrict(params);
  // Capture a read-only target. The old by-identity writer can recreate session
  // metadata, so it must not be used after a concurrent reset or deletion.
  const transcriptPath = legacyTarget(params);
  if (!transcriptPath) return { kind: 'rejected' };
  let rejected = false;
  const append = Reflect.get(harness, 'appendSessionTranscriptMessage') as LegacyAppend;
  const result = await append({
    ...params, transcriptPath,
    prepareMessageAfterIdempotencyCheck: () => {
      if (legacyTarget(params) !== transcriptPath) { rejected = true; return undefined; }
      const message = params.prepareMessageAfterIdempotencyCheck();
      if (legacyTarget(params) !== transcriptPath) { rejected = true; return undefined; }
      return message;
    },
  });
  if (rejected || legacyTarget(params) !== transcriptPath) return { kind: 'rejected' };
  if (!result) return { kind: 'suppressed' };
  return { kind: 'result', result: { appended: result.appended, anchor: { messageId: result.messageId } } };
};

export const publishSessionTranscriptUpdateByIdentity: typeof transcript.publishSessionTranscriptUpdateByIdentity = async params => {
  if (typeof transcript.appendSessionTranscriptMessageByIdentityStrict === 'function') return transcript.publishSessionTranscriptUpdateByIdentity(params);
  const sessionFile = legacyTarget(params);
  if (sessionFile) {
    const emit = Reflect.get(harness, 'emitSessionTranscriptUpdate') as (file: string) => void;
    emit(sessionFile);
  }
};
