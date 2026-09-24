import { OPENCLAW_TESTED_VERSION } from './compatibility.js';

/** @deprecated Use the compatibility range; retained for wire/report compatibility. */
export const HOST_VERSION = OPENCLAW_TESTED_VERSION;
export const BRIDGE_VERSION = '0.6.4';
export const PROTOCOL_VERSION = 4;

export type JsonObject = Record<string, unknown>;
export const ALL_PERMISSIONS = ['workspace:read', 'memory:read', 'memory:write'] as const;
export type Permission = typeof ALL_PERMISSIONS[number];
export type CapabilityRule = { allow?: string[]; deny?: string[] };
export type Requester = { channel: string; accountId: string; senderId: string };
export type Principal = { kind: 'operator' } | { kind: 'agent'; agentId: string; requester?: Requester };
export type CapabilityPolicy = {
  defaults: CapabilityRule;
  agents: Record<string, CapabilityRule>;
  requesters: Array<Requester & CapabilityRule>;
  operator: CapabilityRule;
  requireRequester: boolean;
};
export type CatalogRequest = { principal: Principal; permissions: Permission[]; capabilityCeiling?: CapabilityRule };
export type CapabilityCatalog = { generation: string; capabilities: PublishedCapability[] };
export type ProgressState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export interface Progress {
  callId: string;
  state: ProgressState;
  message: string;
  at: number;
}
export interface CapabilityDescriptor {
  name: string;
  /** Opt-in bounded task-text -> workspace context contract; not a sandbox or purity guarantee. */
  contextProvider?: 'workspace-v1';
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  permissions: Permission[];
}
export interface PublishedCapability extends CapabilityDescriptor {
  provider: { id: string; version: string };
}
export interface ComponentManifest {
  id: string;
  version: string;
  description: string;
  entry: string;
  requires: Record<string, string>;
  capabilities: CapabilityDescriptor[];
  configSchema?: JsonObject;
  bridgeVersion?: string;
}
export interface ComponentSpec {
  manifest: ComponentManifest;
  config: JsonObject;
  enabled: boolean;
  manifestFile?: string;
  integrity?: string;
}
export interface BridgeConfig {
  workspaceRoot: string;
  memoryFilePath?: string;
  components: ComponentSpec[];
  permissions: Permission[];
  maxConcurrent: number;
  capabilityPolicy: CapabilityPolicy;
  maxQueued: number;
  maxTasks: number;
  taskTtlMs: number;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxPayloadBytes: number;
  maxRetiredGenerations: number;
  abortGraceMs: number;
}
export interface Invocation {
  /** Derived by the worker from its validated principal, never from capability arguments. */
  memorySubject?: string;
  callId: string;
  taskId: string;
  subject: string;
  workspaceRoot: string;
  permissions: Permission[];
  capabilityPath: string[];
  allowedCapabilities: readonly string[];
  signal: AbortSignal;
  progress(message: string): void;
}
export type CapabilityHandler = (args: JsonObject, invocation: Invocation) => Promise<unknown>;
export interface ComponentModule<TContext = unknown> {
  name?: string;
  inject?: string[];
  apply(ctx: TContext, config: JsonObject): void | Promise<void>;
}
export interface ComponentStatus {
  id: string;
  version: string;
  state: 'ready' | 'disabled' | 'blocked';
  reason?: string;
  reasonCode?: 'dependency' | 'activation' | 'cycle';
  requires: Record<string, string>;
  enabled: boolean;
  integrity?: string;
}
export interface RuntimeStatus {
  protocol: number;
  /** Reproducible adapter build pin; use hostCompatibility for accepted hosts. */
  hostVersion: string;
  hostCompatibility: string;
  pid: number;
  revision: string;
  state: 'ready' | 'degraded';
  components: ComponentStatus[];
  capabilities: PublishedCapability[];
  active: number;
  queued: number;
  tasks: number;
  retiredGenerations: number;
  memoryRssBytes: number;
  grants: number;
  policyDenials: number;
  capabilityPolicy: CapabilityPolicy;
  lastReloadError?: string;
  cleanupErrors?: string[];
}
export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BridgeError';
  }
}
export function errorData(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof BridgeError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
