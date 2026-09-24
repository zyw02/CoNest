import {
  LocalSubprocessRuntime,
  SystemPrompt,
  ToolFsSearch,
} from './adapters/dsh-search.js';
import type { Agent } from './adapters/dsh-agent.js';
import type { CordisContext as Context } from './adapters/dsh-cordis.js';
import { createDetachedSession, SessionId } from './adapters/dsh-session.js';
import { ToolCallId, ToolRuntime } from './adapters/dsh-tools.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { inside } from './config.js';
import { managedSearchTools } from './search-contract.js';
import { startFiber } from './components.js';
import { BridgeError, type ComponentModule, type Invocation, type JsonObject } from './types.js';
export const dshSearchComponent: ComponentModule<Context> = {
  name: 'dsh-search',
  inject: ['bridgeCapabilities', 'tools', 'systemPrompt', 'subprocess'],
  async apply(ctx) {
    await ctx.plugin(ToolFsSearch, {
      sampleOverCapGlobResults: false,
      grepMaxMatches: 250,
      grepMaxLineBytes: 2_000,
      searchMetaMaxBytes: 65_536,
      rawOutputMaxBytes: 20_000_000,
      graceMs: 3_000,
      stderrMaxBytes: 65_536,
      timeoutMs: 30_000,
    });
    ctx.bridgeCapabilities.register(ctx, 'knowledge_search', async (args, invocation) => {
      const query = args.query as string;
      invocation.progress('Searching workspace sources');
      const startedAt = performance.now();
      const result = await executeSearch(ctx, 'grep', { pattern: escapeRegex(query) }, invocation, false);
      const matches = readMatches(result.value);
      return {
        query,
        matches: matches.slice(0, 100),
        totalMatches: matches.length,
        truncated: matches.length > 100,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
    });
    for (const tool of managedSearchTools) {
      ctx.bridgeCapabilities.register(ctx, tool.openClawName, async (args, invocation) => {
        invocation.progress(`Searching workspace with ${tool.dshName}`);
        const result = await executeSearch(ctx, tool.dshName, args, invocation, true);
        // Preserve DSH's rendered text and canonical value across the process boundary.
        return { content: result.content, value: result.value };
      });
    }
  },
};

async function executeSearch(ctx: Context, name: 'grep' | 'glob', args: JsonObject, invocation: Invocation, nativeView: boolean) {
  invocation.signal.throwIfAborted();
  if (args.path !== undefined && (typeof args.path !== 'string' || !args.path.trim())) {
    throw new BridgeError('INVALID_ARGUMENTS', 'Search path must be a non-empty string');
  }
  // Compare paths resolved by the same filesystem API. On Windows the sync
  // and native async APIs can represent junctions / short paths differently.
  const root = await realpath(invocation.workspaceRoot);
  const target = await realpath(path.resolve(root, typeof args.path === 'string' ? args.path : '.'));
  if (!inside(root, target)) throw new BridgeError('PERMISSION_DENIED', 'Search path must remain inside the authorized workspace');
  invocation.signal.throwIfAborted();
  // Detached tool owner supplies DSH's workspace-relative presentation only. It is
  // never published to SessionStore and runs no Agent Loop or model; no cached sessions.
  const id = SessionId(`conest-search:${invocation.taskId}`);
  const agent = nativeView ? {
    id, ctx, options: {}, status: 'idle',
    session: createDetachedSession(id, root),
  } as Agent : undefined;
  const result = await ctx.tools.execute({
    callId: ToolCallId(invocation.callId), name, arguments: { ...args, path: target },
    ...(agent ? { agent } : {}), signal: invocation.signal,
  });
  invocation.signal.throwIfAborted();
  if (result.isError) throw new BridgeError(result.error.info?.code ?? 'SEARCH_FAILED', result.error.message);
  return result;
}

export async function startSearchInfrastructure(ctx: Context): Promise<void> {
  await startFiber(ctx, SystemPrompt, {});
  await startFiber(ctx, ToolRuntime, { mode: 'native' });
  await startFiber(ctx, LocalSubprocessRuntime, {});
}

type SearchMatch = { path: string; lineNumber: number; line: string };
type SearchResult = { matches: SearchMatch[] };

function readMatches(value: unknown): SearchMatch[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { matches?: unknown }).matches)) {
    throw new BridgeError('INVALID_COMPONENT_RESULT', 'DSH search returned an invalid result');
  }
  return (value as { matches: unknown[] }).matches.map(item => {
    if (!item || typeof item !== 'object') throw new BridgeError('INVALID_COMPONENT_RESULT', 'DSH search returned an invalid match');
    const match = item as Partial<SearchMatch>;
    if (typeof match.path !== 'string' || typeof match.lineNumber !== 'number' || typeof match.line !== 'string') {
      throw new BridgeError('INVALID_COMPONENT_RESULT', 'DSH search returned an invalid match');
    }
    return { path: match.path, lineNumber: match.lineNumber, line: match.line };
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
