import { randomUUID } from 'node:crypto';
import { isIncognitoSessionKey } from './adapters/openclaw-sdk.js';
import { configuredHostCeiling, hostPrincipal } from './host-policy.js';
import { BridgeError, type BridgeConfig, type JsonObject } from './types.js';
import type { ClientInvocation } from './client.js';

export type MemoryContext = { agentId?: string; sessionKey?: string; runId?: string; channel?: string; accountId?: string; senderId?: string; modelProviderId?: string; modelId?: string };
export type MemoryAccess = (capability: 'memory_recall' | 'memory_remember', args: JsonObject, context?: MemoryContext, signal?: AbortSignal) => Promise<{ observations?: string[]; action?: string }>;
/** Studio opts into automatic memory as a service. Model tools separately require finalized tool authority. */
export function createMemoryAccess(host: { invoke(input: ClientInvocation): Promise<{ value: unknown }> }, config: BridgeConfig, readHostConfig: () => unknown): MemoryAccess {
  return async (capability, args, context, signal) => {
    if (isIncognitoSessionKey(context?.sessionKey)) throw new BridgeError('MEMORY_INCOGNITO', 'Memory is unavailable in incognito sessions');
    if (!config.memoryFilePath) throw new BridgeError('MEMORY_NOT_CONFIGURED', 'No shared memory file is configured');
    // A partially supplied sender identity must never fall back to the agent-wide bucket.
    if (context?.senderId && !context.channel) throw new BridgeError('IDENTITY_UNAVAILABLE', 'Automatic memory requires the sender channel');
    const principal = context ? hostPrincipal({ agentId: context.agentId, messageChannel: context.channel,
      agentAccountId: context.accountId || (context.senderId ? 'default' : undefined), requesterSenderId: context.senderId }) : { kind: 'operator' as const };
    const result = await host.invoke({ capability, args, principal,
      capabilityCeiling: configuredHostCeiling(readHostConfig(), context?.agentId ?? 'main', { provider: context?.modelProviderId, modelId: context?.modelId }),
      permissions: capability === 'memory_recall' ? ['memory:read'] : ['memory:write'],
      workspaceRoot: config.workspaceRoot, subject: context?.sessionKey ?? 'studio-operator',
      taskId: randomUUID(), callId: randomUUID(), parentTaskId: context?.runId,
      signal: AbortSignal.any([AbortSignal.timeout(2000), ...signal ? [signal] : []]), recordProgress: false,
    });
    return result.value as { observations?: string[]; action?: string };
  };
}
