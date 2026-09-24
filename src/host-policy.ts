import { BridgeError, type CapabilityRule, type Principal } from './types.js';
import { DIRECT_CAPABILITY_NAMES } from './managed-tools.js';
import { matchesCapability } from './policy.js';

type IdentityContext = { agentId?: string; messageChannel?: string; agentAccountId?: string; requesterSenderId?: string };

export function hostPrincipal(context: IdentityContext): Principal {
  if (!context.agentId) throw new BridgeError('IDENTITY_UNAVAILABLE', 'OpenClaw did not supply the owning agent identity');
  const requester = context.messageChannel && context.agentAccountId && context.requesterSenderId
    ? { channel: context.messageChannel, accountId: context.agentAccountId, senderId: context.requesterSenderId } : undefined;
  return { kind: 'agent', agentId: context.agentId, ...(requester ? { requester } : {}) };
}

/** Copy only negative restrictions; this does not issue or retain OpenClaw authority. */
export function configuredHostCeiling(config: unknown, agentId: string, model?: { provider?: string; modelId?: string }): CapabilityRule {
  const root = object(config);
  const agents = object(root.agents);
  const agent = object(object(agents.entries)[agentId]);
  const policies = [object(root.tools), object(agent.tools)];
  const deny = new Set<string>();
  for (const policy of [...policies]) {
    const providers = object(policy.byProvider);
    if (model?.provider) {
      policies.push(object(providers[model.provider]));
      if (model.modelId) policies.push(object(providers[`${model.provider}/${model.modelId}`]));
    } else {
      // Direct operator HTTP calls may lack model metadata. Intersect every provider restriction.
      policies.push(...Object.values(providers).map(object));
    }
  }
  for (const policy of policies) {
    for (const pattern of strings(policy.deny)) {
      if (pattern === 'dsh-bridge' || pattern === 'group:plugins') deny.add('*');
      else if (/^[a-z0-9_*]+$/i.test(pattern) && !['bridge_capabilities', 'bridge_invoke'].includes(pattern)) deny.add(pattern.toLowerCase());
    }
    const allow = strings(policy.allow);
    if (allow.length > 0) for (const name of DIRECT_CAPABILITY_NAMES) {
      if (![...allow, ...strings(policy.alsoAllow)].some(pattern => ['dsh-bridge', 'group:plugins'].includes(pattern) || matchesCapability(pattern, name))) deny.add(name);
    }
  }
  return { deny: [...deny].sort() };
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
