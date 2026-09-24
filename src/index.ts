import {
  createRuntimeConfigReader,
  defineToolPlugin,
  isIncognitoSessionKey,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from './adapters/openclaw-sdk.js';
import { MEMORY_CAPABILITIES } from './memory-contract.js';
import { createMemoryAccess } from './memory-adapter.js';
import { Type } from 'typebox';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, readConfig, resolveConfig } from './config.js';
import { borrowHost } from './shared-host.js';
import { configuredHostCeiling, hostPrincipal } from './host-policy.js';
import { cleanupHostScope, registerHostAdapter, scopedCallId, type HostToolName as ToolName } from './host-adapter.js';
import { isManagedDshTool, managedDshTools } from './managed-tools.js';
import type { ManagedReadResult } from './read-contract.js';
import { registerStudio } from './studio/index.js';
import { ContextProvider, parseContextProvider, type ContextProviderConfig } from './context-provider.js';
import { BridgeError, type BridgeConfig, type CapabilityDescriptor, type JsonObject, type Permission } from './types.js';
import { inspectOpenClaw } from './compatibility.js';
import { formatStatus, renderProgress, renderStatusPage, renderToolResult } from './ui.js';
import { COMMAND_NAMES, CONNECTOR_FULL_NAME, CONNECTOR_NAME, PLUGIN_ID, STATUS_PATHS } from './branding.js';

const require = createRequire(import.meta.url);
const openClawEntry = require.resolve('openclaw/plugin-sdk/plugin-entry');
const openClawManifest = JSON.parse(readFileSync(path.resolve(path.dirname(openClawEntry), '../../package.json'), 'utf8')) as { version?: unknown };
export const openClawCompatibility = inspectOpenClaw(openClawManifest.version);

const configSchema = Type.Object({
  studio: Type.Optional(Type.Object({ stateDir: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  contextProvider: Type.Optional(Type.Object({
    capability: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
    provider: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 2000 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 128, maximum: 4000 })),
  }, { additionalProperties: false, description: 'Explicitly enable one installed workspace-v1 context capability. Shares up to 1000 characters of the current task; never session history.' })),
  capabilityGuidance: Type.Optional(Type.Boolean({ description: 'Append static capability usage guidance when both discovery and invocation tools are authorized. Defaults to false.' })),
  configFile: Type.Optional(Type.String({ minLength: 1, description: 'Path to the separate CoNest Runtime JSON configuration file.' })),
  workspaceRoot: Type.Optional(Type.String({ minLength: 1, description: 'Workspace directory available to search components.' })),
}, { additionalProperties: false });
const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$', description: 'Literal single-line text to find in workspace files.' }),
}, { additionalProperties: false });
const verifyParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$', description: 'Literal single-line text used to select candidate source files.' }),
  quote: Type.String({ minLength: 1, maxLength: 2_000, pattern: '^[^\\r\\n]+$', description: 'Exact single-line source text to verify.' }),
}, { additionalProperties: false });
const catalogParameters = Type.Object({
  capability: Type.Optional(Type.String({ minLength: 1, description: 'Optional capability name to inspect.' })),
}, { additionalProperties: false });
const invokeParameters = Type.Object({
  capability: Type.String({ minLength: 1, description: 'Exact capability name returned by bridge_capabilities.' }),
  generation: Type.String({ minLength: 1, description: 'Generation returned by the latest bridge_capabilities response.' }),
  args: Type.Record(Type.String(), Type.Unknown(), { description: 'Arguments matching the capability inputSchema.' }),
}, { additionalProperties: false });

type PluginState = { config: BridgeConfig; contextProviderConfig?: ContextProviderConfig; studio?: ReturnType<typeof registerStudio> } & ReturnType<typeof borrowHost>;
const states = new WeakMap<OpenClawPluginApi, PluginState>();

const entry = defineToolPlugin({
  id: PLUGIN_ID,
  name: CONNECTOR_FULL_NAME,
  description: 'Connect OpenClaw to DSH/Cordis components managed by CoNest Runtime.',
  configSchema,
  tools: tool => [
    ...managedDshTools.map(descriptor => tool({
      name: descriptor.openClawName, label: `DSH · ${descriptor.dshName}`,
      description: descriptor.description, parameters: descriptor.parameters,
      factory: context => createTool(context.api, context.toolContext, descriptor.openClawName, descriptor.parameters),
    })),
    tool({
      name: 'bridge_capabilities', label: 'Discover component capabilities',
      description: 'Discover currently available component capabilities, original providers, parameter schemas, permissions, and generation. Use before bridge_invoke; newly installed components appear without changing this adapter.',
      parameters: catalogParameters,
      factory: context => createTool(context.api, context.toolContext, 'bridge_capabilities', catalogParameters),
    }),
    tool({
      name: 'bridge_invoke', label: 'Invoke a component capability',
      description: 'Invoke a currently authorized component capability discovered with bridge_capabilities. Supply its exact name, generation, and schema-valid args. A stale generation requires rediscovery. This uses the current OpenClaw task and does not start another Agent Loop.',
      parameters: invokeParameters,
      factory: context => createTool(context.api, context.toolContext, 'bridge_invoke', invokeParameters),
    }),
    tool({
      name: 'knowledge_search',
      label: 'Workspace knowledge search',
      description: 'Search literal text in this workspace using DSH. Returns source paths, line numbers, and excerpts without a model call.',
      parameters: searchParameters,
      factory: context => createTool(context.api, context.toolContext, 'knowledge_search', searchParameters),
    }),
    tool({
      name: 'knowledge_verify',
      label: 'Verify quoted source',
      description: 'Re-search workspace sources and check whether exact single-line text occurs in a file that matches the query.',
      parameters: verifyParameters,
      factory: context => createTool(context.api, context.toolContext, 'knowledge_verify', verifyParameters),
    }),
  ],
});

const registerTools = entry.register;
entry.register = (api: OpenClawPluginApi): void => {
  const state = createState(api);
  states.set(api, state);
  registerTools(api);
  registerRuntime(api, state);
  state.studio = registerStudio(api, state.config.workspaceRoot, state.scopes, createMemoryAccess(state.host, state.config, createRuntimeConfigReader(api.config)), state.host);
};

function createState(api: OpenClawPluginApi): PluginState {
  if (!openClawCompatibility.tested) {
    api.logger.warn?.(`${CONNECTOR_NAME} loaded OpenClaw ${openClawCompatibility.installed} within ${openClawCompatibility.supported}; this exact release is not yet in the tested matrix`);
  }
  const contextProviderConfig = parseContextProvider(api.pluginConfig?.contextProvider);
  const base = path.resolve(api.rootDir ?? process.cwd());
  const configuredFile = optionalString(api.pluginConfig, 'configFile');
  const configuredWorkspace = optionalString(api.pluginConfig, 'workspaceRoot');
  const configFile = configuredFile ? path.resolve(base, configuredFile) : undefined;
  const studio = api.pluginConfig?.studio as { stateDir?: string } | undefined;
  if (studio && (!studio.stateDir || !path.isAbsolute(studio.stateDir))) throw new Error('CoNest Studio requires an absolute stateDir');
  const memoryFilePath = studio?.stateDir ? path.join(studio.stateDir, 'memory.jsonl') : undefined;
  const config = configFile
    ? readConfig(configFile, memoryFilePath)
    : resolveConfig({ workspaceRoot: configuredWorkspace ? path.resolve(base, configuredWorkspace) : base }, base, memoryFilePath);
  const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
  const shared = borrowHost(JSON.stringify([configFile ? realpathSync(configFile) : `workspace:${config.workspaceRoot}`, config.memoryFilePath]), {
    workerFile, memoryFilePath,
    ...(configFile ? { configFile } : { workspaceRoot: config.workspaceRoot }),
    startupTimeoutMs: config.startupTimeoutMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    maxPayloadBytes: config.maxPayloadBytes,
    onLog: (level, message) => api.logger[level]?.(`CoNest Runtime: ${message}`),
  }, config.taskTtlMs, Math.max(1024, config.maxTasks * 16));
  return { config, contextProviderConfig, ...shared };
}

function createTool(
  api: OpenClawPluginApi,
  toolContext: OpenClawPluginToolContext,
  name: ToolName,
  parameters: AnyAgentTool['parameters'],
): AnyAgentTool | null {
  const state = states.get(api);
  if (!state) throw new Error('CoNest Connector plugin state is unavailable');
  const permissions = toolPermissions(toolContext.fsPolicy, toolContext.workspaceDir, state.config.workspaceRoot);
  if (toolContext.sandboxed || !permissions.includes('workspace:read')) return null;
  const incognito = isIncognitoSessionKey(toolContext.sessionKey);
  if (incognito && MEMORY_CAPABILITIES.includes(name)) return null;
  if (!incognito && state.config.memoryFilePath) permissions.push('memory:read', 'memory:write');
  const descriptor = name !== 'bridge_capabilities' && name !== 'bridge_invoke' ? findDescriptor(state.config, name) : undefined;
  return {
    name,
    label: name,
    description: descriptor?.description ?? (name === 'bridge_capabilities'
      ? 'Discover available component capabilities and input schemas; use the returned generation with bridge_invoke.'
      : 'Invoke a capability by its discovered name, generation, and schema-valid arguments.'),
    parameters,
    async execute(toolCallId: string, raw: unknown, signal?: AbortSignal, onUpdate?: Parameters<AnyAgentTool['execute']>[3]) {
      const args = object(raw);
      const scopeId = scopedCallId(toolContext, toolCallId);
      const binding = state.scopes.claim(scopeId, signal, toolContext);
      const subject = toolContext.sessionId ?? toolContext.sessionKey ?? toolContext.agentId ?? 'openclaw-global';
      try {
      const principal = binding.principal ?? hostPrincipal(toolContext);
      if (principal.kind !== 'agent') throw new BridgeError('INVALID_PRINCIPAL', 'Host tools require an agent principal');
      const capabilityCeiling = configuredHostCeiling(toolContext.getRuntimeConfig?.() ?? toolContext.runtimeConfig ?? toolContext.config ?? api.config, principal.agentId, toolContext.activeModel);
      capabilityCeiling.deny = [...new Set([...capabilityCeiling.deny ?? [], ...state.scopes.runDenials(binding.runId), 'memory_recall', 'memory_remember', ...(incognito ? MEMORY_CAPABILITIES : [])])];
      if (name === 'bridge_capabilities') {
        const catalog = await state.host.catalog({ principal, permissions, capabilityCeiling });
        binding.signal.throwIfAborted();
        const capabilities = catalog.capabilities.filter(capability => args.capability === undefined || args.capability === capability.name);
        const value = { generation: catalog.generation, capabilities };
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
      }
      const capability = name === 'bridge_invoke' ? requiredString(args, 'capability') : name;
      const result = await state.host.invoke({
        capability,
        args: name === 'bridge_invoke' ? object(args.args) : args,
        expectedGeneration: name === 'bridge_invoke' ? requiredString(args, 'generation') : undefined,
        taskId: randomUUID(),
        callId: toolCallId,
        subject,
        principal,
        capabilityCeiling,
        parentTaskId: binding.runId,
        workspaceRoot: state.config.workspaceRoot,
        permissions,
        signal: binding.signal,
        onProgress: progress => {
          api.logger.debug?.(`CoNest Runtime ${progress.callId} ${progress.state}: ${progress.message}`);
          onUpdate?.({
            content: [], details: { state: progress.state },
            progress: { text: renderProgress(progress), visibility: 'channel', privacy: 'public', id: 'dsh-bridge' },
          });
        },
      });
      let publicValue = result.value;
      if (capability === 'dsh_read') {
        const read = result.value as ManagedReadResult;
        binding.signal.throwIfAborted();
        if (read.observation && state.studio) await state.studio.observeRead(read.observation,
          toolContext.sessionKey ?? toolContext.sessionId ?? toolContext.agentId ?? 'operator', binding.signal);
        binding.signal.throwIfAborted();
        if (read.isError) throw new BridgeError(read.error?.code ?? 'READ_FAILED', read.error?.message ?? 'File read failed');
        publicValue = { content: read.content, value: read.value };
      }
      if (isManagedDshTool(name)) {
        const search = object(publicValue);
        return { content: search.content as Array<{ type: 'text'; text: string }>,
          details: { source: 'dsh', tool: name.slice(4), bridge: 'cordis-process', generation: result.generation, value: search.value } };
      }
      return {
        content: [{ type: 'text' as const, text: renderToolResult(capability, publicValue) }],
        details: { bridge: 'cordis-process', generation: result.generation, value: publicValue },
      };
      } finally { state.scopes.endCall(scopeId); }
    },
  };
}

function registerRuntime(api: OpenClawPluginApi, state: PluginState): void {
  const { host } = state;
  const contextProvider = state.contextProviderConfig ? new ContextProvider({
    config: state.contextProviderConfig, host, scopes: state.scopes, workspaceRoot: state.config.workspaceRoot,
    readHostConfig: createRuntimeConfigReader(api.config), diagnostics: state.contextDiagnostics,
  }) : undefined;
  registerHostAdapter(api, state.scopes, {
    capabilityGuidance: api.pluginConfig?.capabilityGuidance === true,
    collectContext: contextProvider ? (prompt, context) => contextProvider.collect(prompt, context) : undefined,
  });
  const snapshot = () => ({ ...host.snapshot(), context: { enabled: !!state.contextProviderConfig, ...state.contextDiagnostics.snapshot() } });
  api.registerService({
    id: 'dsh-bridge-worker',
    reload: { configPrefixes: ['plugins.entries.dsh-bridge.config'] },
    async start(context) {
      contextProvider?.open();
      try {
        const start = () => state.startService();
        if (context.startupTrace) await context.startupTrace.measure('dsh-bridge.worker.start', start);
        else await start();
        context.serviceHealth?.clearFailure();
      } catch (error) {
        context.serviceHealth?.reportFailure(error);
        throw error;
      }
    },
    async stop() {
      await state.stopService();
      if (!state.serviceRunning()) contextProvider?.close();
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: 'dsh-bridge-cleanup',
    async cleanup(context) {
      if (cleanupHostScope(context, state.scopes)) return;
      await state.release();
      // Borrowed registries can be retired by session reset while the owning service
      // still dispatches prompt hooks. Their cleanup must not close that service's work.
      if (!state.serviceRunning()) contextProvider?.close();
      states.delete(api);
    },
  });
  for (const name of COMMAND_NAMES) api.registerCommand({
    name, description: 'Show or reload CoNest Runtime', acceptsArgs: true, requireAuth: true,
    handler: async context => {
      if (context.args?.trim() === 'reload') await host.reload();
      else if (context.args?.trim() === 'restart') await host.restart();
      else {
        try { await host.refresh(); } catch { /* The snapshot includes the actionable process failure. */ }
      }
      return { text: formatStatus(snapshot()) };
    },
  });
  for (const path of STATUS_PATHS) api.registerHttpRoute({
    path, auth: 'gateway', match: 'exact', gatewayRuntimeScopeSurface: 'trusted-operator',
    handler: async (_request, response) => {
      try { await host.refresh(); } catch { /* Render the last known state. */ }
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(renderStatusPage(snapshot()));
      return true;
    },
  });
  api.session.controls.registerControlUiDescriptor({
    surface: 'tab', id: PLUGIN_ID, label: CONNECTOR_NAME,
    description: 'Inspect component health, task load, and available capabilities.',
    path: STATUS_PATHS[0], icon: 'plug', group: 'agent', order: 30,
    requiredScopes: ['operator.read'],
  });
}

function findDescriptor(config: BridgeConfig, name: string): CapabilityDescriptor {
  const descriptor = config.components.flatMap(component => component.manifest.capabilities).find(item => item.name === name);
  if (!descriptor) throw new Error(`CoNest Runtime capability ${name} is not declared`);
  return descriptor;
}

function toolPermissions(
  fsPolicy: { workspaceOnly: boolean; root?: string } | undefined,
  workspaceDir: string | undefined,
  configuredRoot: string,
): Permission[] {
  const policyRoot = fsPolicy?.root ?? workspaceDir;
  if (fsPolicy?.workspaceOnly) {
    if (!policyRoot) return [];
    let canonical: string;
    try { canonical = realpathSync(policyRoot); } catch { return []; }
    if (!inside(canonical, configuredRoot)) return [];
  }
  return ['workspace:read'];
}

function optionalString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`CoNest Connector: ${key} must be a non-empty string`);
  return value;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CoNest Connector tool parameters must be a JSON object');
  return value as JsonObject;
}

function requiredString(args: JsonObject, key: string): string {
  if (typeof args[key] !== 'string' || !args[key]) throw new BridgeError('INVALID_ARGUMENTS', `${key} is required`);
  return args[key] as string;
}

export default entry;
