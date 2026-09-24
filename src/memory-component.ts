import { Context, type CordisContext, type Fiber } from './adapters/dsh-cordis.js';
import { McpClient, SystemPrompt } from './adapters/dsh-memory.js';
import { ToolCallId, ToolRuntime } from './adapters/dsh-tools.js';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock } from './control.js';
import { managedMemoryTools } from './memory-contract.js';
import { selectAutomaticMemory } from './studio/automatic-memory.js';
import { BridgeError, type ComponentModule, type Invocation, type JsonObject } from './types.js';

type Backend = { failed?: boolean; ctx: Context; refs: number; tail: Promise<unknown>; close(): Promise<void> };
// Old and new component generations must use the same MCP writer and queue.
const backends = new Map<string, Backend>();
let lifecycle: Promise<unknown> = Promise.resolve();
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(operation, operation);
  lifecycle = result.catch(() => undefined);
  return result;
}
async function borrow(file: string): Promise<{ backend: Backend; release(): Promise<void> }> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  file = path.join(await realpath(path.dirname(file)), path.basename(file));
  try {
    file = await realpath(file);
    if (!(await stat(file)).isFile()) throw new BridgeError('MEMORY_FILE_INVALID', 'Memory storage must be a regular file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return exclusive(async () => {
    let backend = backends.get(file);
    if (!backend) {
      const lock = `${file}.conest.lock`, nonce = randomUUID();
      await acquireLock(lock, nonce);
      const ctx = new Context(), fibers: Fiber[] = [];
      const dispose = async () => {
        try { for (const fiber of fibers.reverse()) await fiber.dispose(); }
        finally { await releaseLock(lock, nonce); }
      };
      try {
        fibers.push(await ctx.plugin(SystemPrompt));
        fibers.push(await ctx.plugin(ToolRuntime, { mode: 'native' }));
        fibers.push(await ctx.plugin(McpClient, {
          transport: 'stdio', serverName: 'reference_memory', command: process.execPath,
          args: [fileURLToPath(new URL('./mcp-memory-server.mjs', import.meta.url))],
          cwd: path.dirname(file), env: { MEMORY_FILE_PATH: file }, toolCallTimeoutMs: 30_000,
          failOnStartupError: true, reconnect: { enabled: false },
        }));
        backend = { ctx, refs: 0, tail: Promise.resolve(), close: dispose };
        backends.set(file, backend);
      } catch (error) { await dispose(); throw error; }
    }
    backend.refs++;
    const owned = backend;
    let released = false;
    return { backend, release: () => exclusive(async () => {
      if (released) return;
      released = true;
      if (--owned.refs) return;
      await owned.tail;
      try { await owned.close(); } finally { backends.delete(file); }
    }) };
  });
}

/** Cancellation returns promptly; an already submitted write keeps its queue slot until MCP acknowledges it. */
function queued<T>(backend: Backend, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const result = backend.tail.then(async () => {
    signal.throwIfAborted();
    const value = await operation();
    signal.throwIfAborted();
    return value;
  });
  backend.tail = result.catch(() => undefined);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function execute(backend: Backend, name: string, args: JsonObject, invocation: Invocation) {
  invocation.signal.throwIfAborted();
  if (backend.failed) throw new BridgeError('MEMORY_BACKEND_FAILED', 'Memory backend failed; disable and re-enable the component before another operation');
  // Do not send caller cancellation into a committed mutation and then release the queue early.
  const result = await backend.ctx.tools.execute({ name, arguments: args, callId: ToolCallId(`${invocation.callId}:${randomUUID()}`), signal: new AbortController().signal });
  if (result.isError) {
    // ToolRuntime may erase transport error classes. Fail closed on every native error
    // rather than risk another write after an unacknowledged mutation. Never replay.
    backend.failed = true;
    throw new BridgeError(result.error.info?.code ?? 'MEMORY_FAILED', result.error.message);
  }
  invocation.signal.throwIfAborted();
  return { content: result.content.flatMap(c => c.type === 'text' ? [c] : []), value: result.value };
}
function entities(value: unknown): Array<{ name: string; observations: string[] }> {
  const graph = (value as { structuredContent?: { entities?: unknown } } | undefined)?.structuredContent;
  if (!Array.isArray(graph?.entities)) throw new BridgeError('INVALID_COMPONENT_RESULT', 'Memory service returned an invalid graph');
  return graph.entities;
}
export const dshMemoryComponent: ComponentModule<CordisContext> = {
  name: 'dsh-memory', inject: ['bridgeCapabilities'],
  async apply(ctx, config) {
    if (typeof config.file !== 'string') throw new BridgeError('MEMORY_NOT_CONFIGURED', 'No memory file was bound by the worker');
    const { backend, release } = await borrow(config.file);
    ctx.effect(() => release);
    for (const tool of managedMemoryTools) ctx.bridgeCapabilities.register(ctx, tool.openClawName,
      (args, invocation) => queued(backend, invocation.signal, () => execute(backend, tool.dshName, args, invocation)));
    const recall = async (invocation: Invocation) => {
      const entityName = invocation.memorySubject;
      if (!entityName) throw new BridgeError('INVALID_PRINCIPAL', 'Automatic memory requires a trusted principal');
      const result = await execute(backend, 'mcp__reference_memory__open_nodes', { names: [entityName] }, invocation);
      return { entityName, entity: entities(result.value).find(entity => entity.name === entityName) };
    };
    ctx.bridgeCapabilities.register(ctx, 'memory_recall', (_args, invocation) => queued(backend, invocation.signal, async () => {
      const { entityName, entity } = await recall(invocation);
      return { entityName, observations: entity?.observations ?? [] };
    }));
    ctx.bridgeCapabilities.register(ctx, 'memory_remember', (args, invocation) => queued(backend, invocation.signal, async () => {
      const observation = selectAutomaticMemory(args.observation as string, 500);
      if (!observation) throw new BridgeError('INVALID_ARGUMENTS', 'Automatic memory must be a bounded preference or explicit remember request');
      const { entityName, entity } = await recall(invocation);
      if (entity?.observations.includes(observation)) return { action: 'already-present' };
      if (entity) await execute(backend, 'mcp__reference_memory__add_observations', { observations: [{ entityName, contents: [observation] }] }, invocation);
      else await execute(backend, 'mcp__reference_memory__create_entities', { entities: [{ name: entityName, entityType: 'openclaw-automatic-memory', observations: [observation] }] }, invocation);
      return { action: entity ? 'added' : 'created' };
    }));
  },
};
