import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
const snapshot = await import('openclaw/plugin-sdk/runtime-config-snapshot');
const sessionStore = await import('openclaw/plugin-sdk/session-store-runtime');
const transcript = await import('openclaw/plugin-sdk/session-transcript-runtime');
const {
  appendSessionTranscriptMessageByIdentityStrict,
  createRuntimeConfigReader,
  isIncognitoSessionKey,
  projectAgentHarnessTranscriptMessageForDisplay,
} = await import('../../src/adapters/openclaw-sdk.js');
import { configuredHostCeiling } from '../../src/host-policy.js';

// This file runs against every real installed SDK, not mocked export lists.
test('runtime config readers follow refreshes and preserve unrelated configuration', () => {
  const source = { tools: { deny: ['knowledge_search'] } };
  const next = { tools: { deny: ['knowledge_verify'] } };
  const unrelated = { tools: { deny: ['dsh_read'] } };
  snapshot.setRuntimeConfigSnapshot(source, source);
  try {
    const read = createRuntimeConfigReader(source);
    const independent = createRuntimeConfigReader(unrelated);
    assert.deepEqual(read(), source);
    snapshot.setRuntimeConfigSnapshot(next, source);
    assert.deepEqual(read(), next);
    assert.deepEqual(independent(), unrelated);
  } finally { snapshot.clearRuntimeConfigSnapshot(); }
});

test('private sessions and hidden transcript messages stay private on older SDKs', () => {
  assert.equal(isIncognitoSessionKey('agent:main:dashboard:incognito-test'), true);
  assert.equal(isIncognitoSessionKey('agent:main:ordinary'), false);
  const message = { role: 'user' as const, content: 'hidden', timestamp: Date.now() };
  const projected = projectAgentHarnessTranscriptMessageForDisplay({ hidden: true, message });
  assert.equal(Reflect.get(projected, 'display'), false);
  assert.equal(Reflect.get(message, 'display'), undefined, 'Projection cannot mutate the source message');
});

test('legacy and current agent configuration carry the same negative policy ceiling', () => {
  const agent = { id: 'main', tools: { deny: ['dsh_read'], byProvider: { deepseek: { deny: ['knowledge_verify'] } } } };
  for (const agents of [{ list: [agent] }, { entries: { main: agent } }]) {
    assert.deepEqual(configuredHostCeiling({ agents }, 'main', { provider: 'deepseek' }), {
      deny: ['dsh_read', 'knowledge_verify'],
    });
  }
});

test('transcript facade preserves idempotency, suppression and reset-session rejection', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'conest-sdk-transcript-'));
  const sessionKey = 'agent:main:compatibility';
  const sessionId = 'compatibility-session';
  const storePath = path.join(directory, 'sessions.json');
  const message = { role: 'assistant', content: [{ type: 'text', text: 'matrix transcript' }],
    timestamp: Date.now(), idempotencyKey: 'matrix-turn' };
  const params = { agentId: 'main', sessionId, sessionKey, storePath,
    eventId: 'matrix-turn', idempotencyLookup: 'scan' as const, message,
    prepareMessageAfterIdempotencyCheck: () => message };
  try {
    await sessionStore.upsertSessionEntry({ agentId: 'main', sessionKey, storePath, entry: { sessionId, updatedAt: Date.now() } });
    const first = await appendSessionTranscriptMessageByIdentityStrict(params);
    assert.equal(first.kind, 'result');
    assert.ok(first.kind === 'result' && first.result.appended);
    const repeated = await appendSessionTranscriptMessageByIdentityStrict(params);
    assert.ok(repeated.kind === 'result' && !repeated.result.appended);
    const before = await transcript.readSessionTranscriptEvents(params);
    const suppressed = await appendSessionTranscriptMessageByIdentityStrict({ ...params,
      eventId: 'suppressed', message: { ...message, idempotencyKey: 'suppressed' },
      prepareMessageAfterIdempotencyCheck: () => undefined });
    assert.equal(suppressed.kind, 'suppressed');
    await sessionStore.upsertSessionEntry({ agentId: 'main', sessionKey, storePath, entry: { sessionId: 'replacement', updatedAt: Date.now() } });
    assert.equal((await appendSessionTranscriptMessageByIdentityStrict({ ...params, eventId: 'late' })).kind, 'rejected');
    assert.deepEqual(await transcript.readSessionTranscriptEvents(params), before);
    assert.equal(sessionStore.getSessionEntry({ agentId: 'main', sessionKey, storePath, readConsistency: 'latest' })?.sessionId, 'replacement');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
