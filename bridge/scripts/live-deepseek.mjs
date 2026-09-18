import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { assertPrivateFile } from './platform-support.mjs';

// This transport observes real model decisions; it never executes or synthesizes tools.
export async function createLiveDeepSeek(credentialFile, fetchResponse = fetch) {
  await assertPrivateFile(credentialFile);
  const key = parseEnv(await readFile(credentialFile, 'utf8')).DEEPSEEK_API_KEY?.trim();
  assert.ok(key && key !== 'YOUR_API_KEY_HERE', 'DEEPSEEK_API_KEY is missing or a placeholder');
  const maxRequests = 100;
  const maxOutputTokens = 2048;
  const maxInputBytes = 10_000_000;
  const calls = [];
  let inputBytes = 0;
  const redact = text => String(text).replaceAll(key, '[REDACTED]');
  const complete = async input => {
    assert.ok(calls.length < maxRequests, 'The live model request budget is exhausted');
    const body = JSON.stringify({ model: 'deepseek-flash', messages: input.messages, tools: input.tools,
      stream: false, thinking: { type: 'disabled' }, max_tokens: maxOutputTokens });
    inputBytes += Buffer.byteLength(body);
    assert.ok(inputBytes <= maxInputBytes, 'The live model input byte budget is exhausted');
    const call = { request: calls.length + 1, inputBytes: Buffer.byteLength(body), startedAt: new Date().toISOString() };
    calls.push(call);
    const started = performance.now();
    try {
      const response = await fetchResponse('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body, signal: AbortSignal.timeout(45_000),
      });
      call.status = response.status;
      assert.ok(response.ok, `DeepSeek returned HTTP ${response.status}`);
      const result = await response.json();
      assert.ok(result.choices?.[0]?.message, 'DeepSeek returned no assistant message');
      assert.notEqual(result.choices[0].finish_reason, 'length', 'DeepSeek reached the output token ceiling');
      call.model = result.model;
      call.usage = result.usage;
      call.elapsedMs = Math.round(performance.now() - started);
      return result;
    } catch (error) {
      // Do not lock the transport after a single failure: the loop should be
      // able to retry or proceed with remaining tools. Record the failure but
      // allow subsequent requests. The operator is informed via the report.
      call.status = call.status ?? 0;
      call.error = redact(error.message);
      throw new Error(redact(error.message));
    }
  };
  return { complete, redact, report: () => ({ provider: 'DeepSeek official API', requestedModel: 'deepseek-flash',
    thinking: 'disabled', maxRequests, maxOutputTokens, maxInputBytes, inputBytes, calls }) };
}
