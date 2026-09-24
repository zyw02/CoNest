import type { OpenClawPluginApi } from './adapters/openclaw-sdk.js';
import { DIRECT_CAPABILITY_NAMES } from './managed-tools.js';
import { hostPrincipal } from './host-policy.js';
import type { RunScopes } from './run-scope.js';
import type { PromptContext } from './context-provider.js';

export const HOST_TOOL_NAMES = [...DIRECT_CAPABILITY_NAMES, 'bridge_capabilities', 'bridge_invoke'] as const;
export type HostToolName = typeof HOST_TOOL_NAMES[number];

// Static guidance only: component descriptions and catalog data are not system instructions.
export const CAPABILITY_GUIDANCE = 'CoNest capabilities: use bridge_capabilities to discover currently authorized component capabilities and their input schemas. Then use bridge_invoke with the exact capability name, returned generation, and schema-valid args. Rediscover after a stale-generation error. Discovery is not execution permission; respect permission denials and do not retry through another alias. These tools run within the current OpenClaw task; they do not start another Agent Loop.';

export function scopedCallId(context: { sessionKey?: string; sessionId?: string; agentId?: string }, callId: string): string {
  return JSON.stringify([context.sessionKey ?? context.sessionId ?? context.agentId ?? 'openclaw-global', callId]);
}

/** Runtime cleanup is also invoked for individual session resets, not just plugin unload. */
export function cleanupHostScope(context: { sessionKey?: string; runId?: string }, scopes: RunScopes): boolean {
  if (!context.sessionKey && !context.runId) return false;
  if (context.runId) scopes.endRun(context.runId);
  // Session-key-only cleanup has no stable session ID. The session_end hook handles it
  // precisely; do not release the worker, registry state, or a replacement session here.
  return true;
}

/** Host owns the loop and event delivery; the adapter retains only narrowed policy and call scopes. */
export function registerHostAdapter(api: OpenClawPluginApi, scopes: RunScopes, options: {
  capabilityGuidance: boolean;
  collectContext?: (prompt: string, context: PromptContext) => Promise<string | undefined>;
}): void {
  api.on('before_prompt_build', (event, context) => {
    const authority = context.toolAuthority;
    if (!context.runId || !authority) return;
    authority.assertActive();
    const denied = DIRECT_CAPABILITY_NAMES.filter(name => !authority.allows(name));
    const guide = options.capabilityGuidance && authority.allows('bridge_capabilities') && authority.allows('bridge_invoke');
    authority.assertActive();
    scopes.restrictRun(context.runId, denied, context);
    // OpenClaw's authorized pass forwards only prependContext / appendContext.
    if (options.collectContext) return options.collectContext(event.prompt, context).then(text => {
      authority.assertActive();
      const appendContext = [guide ? CAPABILITY_GUIDANCE : undefined, text].filter(Boolean).join('\n\n');
      if (appendContext) return { appendContext };
    }).catch(() => undefined);
    if (guide) return { appendContext: CAPABILITY_GUIDANCE };
  }, { requiresToolAuthority: true });
  api.on('before_tool_call', (event, context) => {
    if (!HOST_TOOL_NAMES.includes(event.toolName as HostToolName)) return;
    const callId = context.toolCallId ?? event.toolCallId;
    if (callId) scopes.observe(scopedCallId(context, callId), context.runId ?? event.runId, context.abortSignal,
      context.agentId ? hostPrincipal({ agentId: context.agentId, messageChannel: context.requester?.channel, agentAccountId: context.requester?.accountId, requesterSenderId: context.requester?.senderId }) : undefined, context);
  });
  api.on('after_tool_call', (event, context) => {
    if (!HOST_TOOL_NAMES.includes(event.toolName as HostToolName)) return;
    const callId = context.toolCallId ?? event.toolCallId;
    if (callId) scopes.endCall(scopedCallId(context, callId));
  });
  api.agent.events.registerAgentEventSubscription({
    id: 'dsh-bridge-task-lifetime', streams: ['lifecycle'],
    handle: event => {
      if (event.data.phase === 'end' || event.data.phase === 'error') scopes.endRun(event.runId);
    },
  });
  api.on('session_end', (event, context) => {
    scopes.endSession({ sessionId: event.sessionId, agentId: context.agentId });
  });
}
