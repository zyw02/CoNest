import { randomUUID } from 'node:crypto';
import { openClawContract, openClawVersion, supportsGatewayRuntimePatch } from './openclaw-version.js';

/** Legacy Gateways classify plugin inventory as an administrative method. */
export function gatewayRequestScopes(method: string): Array<'operator.read' | 'operator.write' | 'operator.admin'> {
  if (method === 'sessions.patch') return ['operator.read', 'operator.write', 'operator.admin'];
  if (method === 'plugins.list') return openClawContract === 'legacy-v1'
    ? ['operator.read', 'operator.admin'] : ['operator.read'];
  return method === 'tools.catalog' ? ['operator.read'] : ['operator.read', 'operator.write'];
}

type GatewayRequest = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>) => Promise<T>;

/** Select execution through the host's supported session API before admission. */
export async function selectGatewayAgentRuntime(request: GatewayRequest, options: {
  sessionKey: string; model: string; runtime: 'openclaw' | 'dsh';
}): Promise<void> {
  if (supportsGatewayRuntimePatch(openClawVersion)) {
    // DSH follows the authored model route; null clears a previous override.
    await request('sessions.patch', { key: options.sessionKey, model: options.model,
      agentRuntime: options.runtime === 'dsh' ? null : 'openclaw' });
    return;
  }
  // Older session schemas have no agentRuntime field. The model directive is
  // their public selection API; auto follows the configured DSH model route.
  const selection = await request<{ runId?: string }>('chat.send', {
    sessionKey: options.sessionKey,
    message: `/model ${options.model} --runtime ${options.runtime === 'dsh' ? 'auto' : 'openclaw'}`,
    idempotencyKey: randomUUID(),
  });
  if (selection.runId) await request('agent.wait', { runId: selection.runId, timeoutMs: 10_000 });
}
