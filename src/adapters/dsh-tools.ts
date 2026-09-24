export { default as ToolRuntime } from '@deepseek-ai/dsh-tools';
export type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools';

import type ToolRuntime from '@deepseek-ai/dsh-tools';

/** DSH renamed this nominal string from CallId to ToolCallId in 0.1.2. */
export type ToolCallId = Parameters<ToolRuntime['execute']>[0]['callId'];
export function ToolCallId(id: string): ToolCallId {
  return id as ToolCallId;
}
