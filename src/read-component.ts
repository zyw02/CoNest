import { AsyncLocalStorage } from 'node:async_hooks';
import { LocalFileSystem } from './adapters/dsh-filesystem.js';
import type { CordisContext } from './adapters/dsh-cordis.js';
import { SystemPrompt } from './adapters/dsh-search.js';
import { ToolCallId, ToolRuntime } from './adapters/dsh-tools.js';
import { selectFsTools } from './fs-tool-subset.js';
import { BridgeError, type ComponentModule } from './types.js';
import type { ManagedReadResult, ReadObservation } from './read-contract.js';

export const dshReadComponent: ComponentModule<CordisContext> = {
  name: 'dsh-read', inject: ['bridgeCapabilities'],
  async apply(ctx) {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(LocalFileSystem, {});
    await ctx.plugin(selectFsTools('reader'), {});
    await ctx.inject(['bridgeCapabilities', 'fs', 'tools'], ctx => {
      const observed = new AsyncLocalStorage<{ receipt?: ReadObservation }>();
      ctx.on('fs/observed', (target, observation) => {
        const current = observed.getStore();
        if (current) current.receipt = { target, observation };
      });
      ctx.bridgeCapabilities.register(ctx, 'dsh_read', async (args, invocation) => {
        invocation.signal.throwIfAborted();
        if (typeof args.file_path !== 'string' || !args.file_path.trim()) throw new BridgeError('INVALID_ARGUMENTS', 'file_path must be a non-empty string');
        const root = await ctx.fs.resolve(invocation.workspaceRoot, { signal: invocation.signal });
        const target = await ctx.fs.resolve(args.file_path, { cwd: invocation.workspaceRoot, signal: invocation.signal });
        if (!ctx.fs.contains(root, target)) throw new BridgeError('PERMISSION_DENIED', 'Read path must remain inside the authorized workspace');
        invocation.progress('Reading workspace source');
        return observed.run({}, async (): Promise<ManagedReadResult> => {
          const result = await ctx.tools.execute({ name: 'read', callId: ToolCallId(invocation.callId),
            arguments: { ...args, file_path: ctx.fs.processPath(target) }, signal: invocation.signal });
          invocation.signal.throwIfAborted();
          const receipt = observed.getStore()?.receipt;
          // Missing-file observations matter to guarded create after a previous read.
          const observation = !result.isError || receipt?.observation.kind === 'absent' ? receipt : undefined;
          return { content: result.content.flatMap(c => c.type === 'text' ? [c] : []),
            value: result.value, isError: !!result.isError,
            ...(result.isError ? { error: { code: result.error.info?.code ?? 'READ_FAILED', message: result.error.message } } : {}),
            ...(observation ? { observation } : {}),
          };
        });
    });
    });
  },
};
