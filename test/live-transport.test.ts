import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveDeepSeek } from '../scripts/live-deepseek.mjs';

const testKey = 'test-only-not-a-real-secret';
const input = { messages: [{ role: 'user', content: 'Synthetic evidence only' }], tools: [] };
async function credential(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-live-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'credentials.env');
  await writeFile(file, `DEEPSEEK_API_KEY=${testKey}\n`, { mode: 0o600 });
  return file;
}

test('live transport keeps real decisions unchanged and enforces finite request budgets', async t => {
  let requests = 0;
  const real = { model: 'deepseek-v4-flash', choices: [{ message: { role: 'assistant', content: 'Actual response' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } };
  const transport = await createLiveDeepSeek(await credential(t), async (url: string, options: RequestInit) => {
    requests++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal((options.headers as Record<string, string>).authorization, `Bearer ${testKey}`);
    const body = JSON.parse(String(options.body));
    assert.equal(body.model, 'deepseek-v4-flash');
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.thinking.type, 'disabled');
    assert.deepEqual(body.messages, input.messages);
    return Response.json(real);
  });
  for (let i = 0; i < 100; i++) assert.deepEqual(await transport.complete(input), real);
  await assert.rejects(transport.complete(input), /request budget/);
  assert.equal(requests, 100);
  assert.equal(transport.report().calls.length, 100);
  assert.ok(!JSON.stringify(transport.report()).includes(testKey));
});

test('live transport blocks oversized inputs and does not replay uncertain upstream failures', async t => {
  const file = await credential(t);
  let requests = 0;
  const transport = await createLiveDeepSeek(file, async () => { requests++; throw new Error(`Unavailable ${testKey}`); });
  await assert.rejects(transport.complete(input), /Unavailable \[REDACTED\]/);
  await assert.rejects(transport.complete(input), /request budget/);
  assert.equal(requests, 1);
  assert.equal(transport.report().calls.length, 1);
  assert.equal(transport.report().calls[0].error, 'Unavailable [REDACTED]');
  const large = await createLiveDeepSeek(file, async () => { throw new Error('Must not call upstream'); });
  await assert.rejects(large.complete({ messages: [{ role: 'user', content: 'x'.repeat(10_000_001) }], tools: [] }), /byte budget/);
});

test('live transport requires private credentials and rejects truncated model responses', async t => {
  const file = await credential(t);
  await chmod(file, 0o644);
  await assert.rejects(createLiveDeepSeek(file), /owner-only/);
  await chmod(file, 0o600);
  const transport = await createLiveDeepSeek(file, async () => Response.json({ choices: [{ message: { content: 'Incomplete' }, finish_reason: 'length' }] }));
  await assert.rejects(transport.complete(input), /output token ceiling/);
  await assert.rejects(transport.complete(input), /request budget/);
});
