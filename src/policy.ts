import { Ajv } from 'ajv';
import { BridgeError, type CapabilityPolicy, type CapabilityRule, type Principal } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const identity = { type: 'string', minLength: 1, maxLength: 256 };
const patterns = { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_*]+$' } };
const ruleProperties = { allow: patterns, deny: patterns };
const ruleSchema = { type: 'object', additionalProperties: false, properties: ruleProperties };
const requesterProperties = { channel: identity, accountId: identity, senderId: identity };
const requesterSchema = { type: 'object', additionalProperties: false, required: ['channel', 'accountId', 'senderId'], properties: requesterProperties };
const validateRule = ajv.compile(ruleSchema);
const validatePrincipal = ajv.compile({ oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'operator' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'agentId'], properties: { kind: { const: 'agent' }, agentId: identity, requester: requesterSchema } },
] });
const validatePolicy = ajv.compile({
  type: 'object', additionalProperties: false,
  properties: {
    defaults: ruleSchema, operator: ruleSchema, requireRequester: { type: 'boolean' },
    agents: { type: 'object', maxProperties: 128, propertyNames: identity, additionalProperties: ruleSchema },
    requesters: { type: 'array', maxItems: 128, items: { ...requesterSchema, properties: { ...requesterProperties, ...ruleProperties } } },
  },
});

export function parsePolicy(value: unknown = {}): CapabilityPolicy {
  if (!validatePolicy(value)) throw new BridgeError('INVALID_POLICY', ajv.errorsText(validatePolicy.errors));
  const policy = value as Partial<CapabilityPolicy>;
  return structuredClone({ defaults: policy.defaults ?? {}, agents: policy.agents ?? {}, requesters: policy.requesters ?? [], operator: policy.operator ?? {}, requireRequester: policy.requireRequester ?? false });
}

export function parsePrincipal(value: unknown): Principal {
  if (!validatePrincipal(value)) throw new BridgeError('INVALID_PRINCIPAL', 'A bounded host-issued agent or local operator identity is required');
  return structuredClone(value as Principal);
}

export function parseCeiling(value: unknown = {}): CapabilityRule {
  if (!validateRule(value)) throw new BridgeError('INVALID_POLICY', ajv.errorsText(validateRule.errors));
  return structuredClone(value as CapabilityRule);
}

/** All matching layers intersect. A later allow rule never overrides an earlier denial. */
export function policyRules(policy: CapabilityPolicy, principal: Principal, ceiling: CapabilityRule = {}): CapabilityRule[] {
  const rules = [policy.defaults, ceiling];
  if (principal.kind === 'operator') return [...rules, policy.operator];
  if (Object.hasOwn(policy.agents, principal.agentId)) rules.push(policy.agents[principal.agentId]!);
  if (!principal.requester) {
    if (policy.requireRequester || policy.requesters.length > 0) rules.push({ allow: [] });
  } else {
    const requester = principal.requester;
    const matching = policy.requesters.filter(rule => rule.channel === requester.channel && rule.accountId === requester.accountId && rule.senderId === requester.senderId);
    if (policy.requesters.length > 0 && matching.length === 0) rules.push({ allow: [] });
    rules.push(...matching);
  }
  return rules;
}

export function allowsCapability(name: string, rules: readonly CapabilityRule[]): boolean {
  return rules.every(rule => !(rule.deny ?? []).some(pattern => matchesCapability(pattern, name))
    && (rule.allow === undefined || rule.allow.some(pattern => matchesCapability(pattern, name))));
}

export function matchesCapability(pattern: string, name: string): boolean {
  pattern = pattern.toLowerCase();
  name = name.toLowerCase();
  let position = 0;
  let cursor = 0;
  let star = -1;
  let retry = 0;
  while (cursor < name.length) {
    if (pattern[position] === '*') { star = position++; retry = cursor; }
    else if (pattern[position] === name[cursor]) { position++; cursor++; }
    else if (star >= 0) { position = star + 1; cursor = ++retry; }
    else return false;
  }
  while (pattern[position] === '*') position++;
  return position === pattern.length;
}
