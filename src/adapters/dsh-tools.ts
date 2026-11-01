export type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools';

import DshToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { settleFiber, type CordisContext } from './dsh-cordis.js';

const batchExecution = typeof Reflect.get(DshToolRuntime.prototype, 'setExecutor') === 'function';

/** New DSH releases separate the registry from its native execution provider. */
export const ToolRuntime = {
  name: 'conest-native-tools',
  async apply(ctx: CordisContext, _config: { mode?: 'native' }) {
    await settleFiber(ctx.plugin(DshToolRuntime, (batchExecution ? {} : { mode: 'native' }) as never));
    if (batchExecution) {
      // This package is installed only for SDK releases that split the executor.
      const packageName = '@deepseek-ai/dsh-tool-executor-native';
      const executor = await import(packageName);
      await settleFiber(ctx.plugin(executor));
    }
  },
};

/** DSH renamed this nominal string from CallId to ToolCallId in 0.1.2. */
type ExecuteInput = Parameters<DshToolRuntime['execute']>[0];
export type ToolCallId = ExecuteInput extends { callId: infer Id } ? Id
  : ExecuteInput extends { calls: readonly { id: infer Id }[] } ? Id : never;
export function ToolCallId(id: string): ToolCallId {
  return id as ToolCallId;
}

/** Keep one-call CoNest semantics across single-call and batch SDK generations. */
export async function executeTool(tools: DshToolRuntime, input: {
  callId: ToolCallId; name: string; arguments: unknown; signal: AbortSignal; agent?: Agent;
}): Promise<ToolExecutionResult> {
  if (!batchExecution) return Reflect.apply(tools.execute, tools, [input]);
  const batch = await Reflect.apply(tools.execute, tools, [{
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    signal: input.signal, ...(input.agent ? { agent: input.agent } : {}),
  }]) as { results: readonly { callId: ToolCallId; result: ToolExecutionResult }[] };
  if (batch.results.length !== 1 || batch.results[0]?.callId !== input.callId) {
    throw new Error('DSH tool batch did not return the requested call result');
  }
  return batch.results[0].result;
}
