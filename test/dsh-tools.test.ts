import assert from 'node:assert/strict';
import test from 'node:test';
import { Context, settleFiber } from '../src/adapters/dsh-cordis.js';
import { SystemPrompt } from '../src/adapters/dsh-search.js';
import { executeTool, ToolCallId, ToolRuntime } from '../src/adapters/dsh-tools.js';

test('native tools preserve call identity, errors, policy denial and drained cancellation', async t => {
  const ctx = new Context();
  const prompt = await settleFiber(ctx.plugin(SystemPrompt));
  const tools = await settleFiber(ctx.plugin(ToolRuntime, { mode: 'native' }));
  t.after(async () => { await tools.dispose(); await prompt.dispose(); });
  let calls = 0;
  ctx.tools.register({
    name: 'echo', description: 'Adapter regression fixture', parameters: { type: 'object' },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      calls++;
      assert.equal(String(execution.callId), 'adapter-call');
      return args;
    },
  });
  const input = { callId: ToolCallId('adapter-call'), name: 'echo',
    arguments: { text: 'quoted "text"\n中文', nested: [true, null, 42] }, signal: new AbortController().signal };
  const result = await executeTool(ctx.tools, input);
  assert.equal(result.isError, false);
  assert.deepEqual(result.value, input.arguments);
  assert.equal(result.content[0]?.type, 'text');
  const missing = await executeTool(ctx.tools, { ...input, name: 'missing' });
  assert.equal(missing.isError, true);
  const release = ctx.tools.guard(() => 'denied by fixture policy');
  const denied = await executeTool(ctx.tools, input);
  assert.equal(denied.isError, true);
  assert.equal(calls, 1, 'Denied calls must not reach the tool body');
  release();

  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let settled = false;
  ctx.tools.register({ name: 'wait', description: 'Cancellation fixture', parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    async execute(_args, execution) {
      ready();
      try {
        await new Promise<void>(resolve => execution.signal.addEventListener('abort', () => resolve(), { once: true }));
        execution.signal.throwIfAborted();
        return null;
      } finally { settled = true; }
    },
  });
  const controller = new AbortController();
  const pending = executeTool(ctx.tools, { ...input, name: 'wait', signal: controller.signal });
  await started;
  controller.abort(new Error('cancel adapter fixture'));
  await pending.then(value => assert.equal(value.isError, true), error => assert.match(String(error), /cancel|abort/i));
  assert.equal(settled, true, 'Cancellation must drain the submitted tool body');

  if (typeof Reflect.get(ctx.tools, 'setExecutor') === 'function') {
    for (const results of [[], [{ callId: 'another-call', result }]]) {
      Reflect.set(ctx.tools, 'execute', async () => ({ results }));
      await assert.rejects(executeTool(ctx.tools, input), /did not return the requested call/);
    }
  }
});
