import type { BridgeConfig, JsonObject, Permission, RuntimeStatus } from './types.js';
import { randomUUID } from 'node:crypto';
import { BridgeError, errorData } from './types.js';
import type { WireEvent, WireRequest, WireResponse } from './protocol.js';
import { BridgeRuntime, type InvokeRequest } from './runtime.js';
import type { AuthorizationRequest, CallScope } from './authorization.js';
import { ComponentManager, parseOperation } from './management.js';
import { readFrames } from './framing.js';
import { serveControl } from './control.js';
import { parsePrincipal, parseCeiling } from './policy.js';

export type ServerOptions = {
  config: BridgeConfig;
  configFile?: string;
  loadConfig(): BridgeConfig;
};

/** Serve task traffic on the inherited pipe and operator traffic on the local socket. */
export async function serve(options: ServerOptions): Promise<void> {
  let maxPayloadBytes = options.config.maxPayloadBytes;
  const finished = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  let runtime: BridgeRuntime;
  let manager: ComponentManager | undefined;
  let closeControl: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const send = (message: WireResponse | WireEvent): void => {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > 2_000_000) throw new BridgeError('RESULT_TOO_LARGE', 'The component result exceeds the 2 MiB response limit');
    if (process.stdout.destroyed) {
      process.stderr.write(`CoNest Runtime send: stdout already destroyed; dropped ${message.id ?? 'event'}\n`);
      return;
    }
    process.stdout.write(frame);
  };
  const manage = async (method: 'status' | 'reload' | 'manage', params: unknown): Promise<RuntimeStatus> => {
    await ready.promise;
    if (closing) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime is stopping');
    if (method === 'status') return runtime.status();
    if (method === 'reload') {
      const result = manager ? await manager.reload() : await runtime.reload(options.loadConfig());
      maxPayloadBytes = options.loadConfig().maxPayloadBytes;
      return result;
    }
    if (!manager) throw new BridgeError('CONFIG_FILE_REQUIRED', 'Component management requires a persistent CoNest Runtime configuration file');
    return await manager.apply(parseOperation(params));
  };
  try {
    if (options.configFile) closeControl = await serveControl(options.configFile, async (method, params, signal) => {
      if (method === 'catalog') {
        await ready.promise;
        return runtime.catalog({ principal: { kind: 'operator' }, permissions: ['workspace:read'] });
      }
      if (method !== 'call') return await manage(method, params);
      await ready.promise;
      const input = object(params);
      if (Object.keys(input).some(key => !['capability', 'args', 'expectedGeneration'].includes(key))) throw new BridgeError('INVALID_REQUEST', 'Operator calls cannot supply identity or policy fields');
      const scope = {
        capability: requiredString(input, 'capability'), taskId: randomUUID(), callId: randomUUID(),
        subject: 'local-operator', workspaceRoot: options.config.workspaceRoot, permissions: ['workspace:read'] as Permission[],
        principal: { kind: 'operator' as const },
      };
      signal.throwIfAborted();
      const grant = runtime.authorize({ ...scope, expectedGeneration: input.expectedGeneration as string | undefined });
      const cancel = () => runtime.cancel(scope.taskId, grant.token);
      signal.addEventListener('abort', cancel, { once: true });
      try { return await runtime.invoke({ ...scope, args: object(input.args), authorization: grant.token }); }
      finally { signal.removeEventListener('abort', cancel); runtime.release(grant.token); }
    });
    runtime = await BridgeRuntime.create(options.config, progress => send({ event: 'progress', data: progress }), taskId => {
      process.stderr.write(`Task ${taskId} ignored cancellation beyond the grace period; terminating the extension process\n`);
      process.exit(70);
    });
    if (options.configFile) manager = new ComponentManager(runtime, options.configFile);
    ready.resolve();
  } catch (error) {
    ready.reject(error);
    void ready.promise.catch(() => {});
    await closeControl?.();
    throw error;
  }

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.stdin.pause();
      process.stdin.destroy();
      try {
        await closeControl?.();
        await runtime.close();
      } finally {
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        finished.resolve();
      }
    })();
    return closing;
  };
  const onSignal = (): void => { void close().catch(reportCleanupFailure); };
  const reportCleanupFailure = (error: unknown): void => {
    process.stderr.write(`CoNest Runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.stdin.once('end', onSignal);
  process.stdout.on('error', onSignal);
  readFrames(process.stdin, () => maxPayloadBytes, line => {
    let request: WireRequest;
    try { request = parseRequest(line); } catch (error) {
      send({ id: 'invalid', ok: false, error: errorData(error) });
      return;
    }
    void handle(request).catch(error => send({ id: request.id, ok: false, error: errorData(error) }));
  }, error => {
    process.stderr.write(`${error.message}\n`);
    void close().catch(reportCleanupFailure);
  });

  async function handle(request: WireRequest): Promise<void> {
    if (closing) throw new BridgeError('BRIDGE_STOPPING', 'The CoNest Runtime is stopping');
    let result: unknown;
    switch (request.method) {
      case 'status': case 'reload': case 'manage':
        result = await manage(request.method, request.params);
        break;
      case 'authorize':
        result = runtime.authorize(parseAuthorization(request.params));
        break;
      case 'catalog': {
        const params = object(request.params);
        result = runtime.catalog({ principal: parsePrincipal(params.principal), capabilityCeiling: parseCeiling(params.capabilityCeiling), permissions: parsePermissions(params.permissions) });
        break;
      }
      case 'invoke':
        result = await runtime.invoke(parseInvoke(request.params));
        break;
      case 'release':
        result = { released: runtime.release(requiredString(object(request.params), 'authorization')) };
        break;
      case 'cancel': {
        const params = object(request.params);
        result = { cancelled: runtime.cancel(requiredString(params, 'taskId'), requiredString(params, 'authorization')) };
        break;
      }
      case 'shutdown':
        send({ id: request.id, ok: true, result: { stopping: true } });
        await close();
        return;
    }
    send({ id: request.id, ok: true, result });
  }
  await finished.promise;
}

function parseRequest(line: string): WireRequest {
  const request = object(JSON.parse(line));
  requiredString(request, 'id');
  const method = requiredString(request, 'method');
  if (!['status', 'catalog', 'authorize', 'release', 'invoke', 'cancel', 'reload', 'manage', 'shutdown'].includes(method)) {
    throw new BridgeError('METHOD_NOT_FOUND', `Unknown CoNest Runtime method ${method}`);
  }
  return request as WireRequest;
}

function parseScope(params: JsonObject): CallScope {
  return {
    capability: requiredString(params, 'capability'),
    taskId: requiredString(params, 'taskId'),
    callId: requiredString(params, 'callId'),
    subject: requiredString(params, 'subject'),
    workspaceRoot: requiredString(params, 'workspaceRoot'),
    permissions: parsePermissions(params.permissions),
    principal: parsePrincipal(params.principal),
    capabilityCeiling: parseCeiling(params.capabilityCeiling),
    ...(params.parentTaskId === undefined ? {} : { parentTaskId: requiredString(params, 'parentTaskId') }),
  };
}

function parsePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.length > 1 || value.some(item => item !== 'workspace:read')) throw new BridgeError('INVALID_REQUEST', 'The call contains invalid permissions');
  return value as Permission[];
}

function parseAuthorization(value: unknown): AuthorizationRequest {
  const params = object(value);
  if (params.expiresAt !== undefined && (typeof params.expiresAt !== 'number' || !Number.isSafeInteger(params.expiresAt))) {
    throw new BridgeError('INVALID_REQUEST', 'The authorization deadline must be an integer timestamp');
  }
  return {
    ...parseScope(params),
    ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt as number }),
    ...(params.expectedGeneration === undefined ? {} : { expectedGeneration: requiredString(params, 'expectedGeneration') }),
  };
}

function parseInvoke(value: unknown): InvokeRequest {
  const params = object(value);
  return { ...parseScope(params), args: object(params.args), authorization: requiredString(params, 'authorization') };
}

function requiredString(value: JsonObject, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.length === 0 || result.length > 4096) throw new BridgeError('INVALID_REQUEST', `A bounded ${key} string is required`);
  return result;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_REQUEST', 'Expected a JSON object');
  return value as JsonObject;
}
