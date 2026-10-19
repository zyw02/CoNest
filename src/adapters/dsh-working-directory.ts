import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LocalFileSystem, ToolFs } from './dsh-filesystem.js';
import { settleFiber, type CordisContext, type Fiber } from './dsh-cordis.js';

/** Newer tool suites require the upstream per-session working-directory service. */
export async function mountWorkingDirectory(ctx: CordisContext, defaultDirectory = process.cwd()): Promise<Fiber[]> {
  if (!ToolFs.inject.includes('workingDirectory') || ctx.get('workingDirectory')) return [];
  // Resolve from the tool runtime's peers so the provider uses the same SDK
  // generation. Frozen SDKs do not contain or need this package.
  const require = createRequire(import.meta.url);
  const fromTools = createRequire(require.resolve('@deepseek-ai/dsh-tools/package.json'));
  const provider = fromTools.resolve('@deepseek-ai/dsh-working-directory');
  const fromProvider = createRequire(provider);
  const [{ default: WorkingDirectory }, { default: SessionProjections }] = await Promise.all([
    import(pathToFileURL(provider).href),
    import(pathToFileURL(fromProvider.resolve('@deepseek-ai/dsh-session-projection')).href),
  ]);
  const fibers: Fiber[] = [];
  const mount = async (fiber: Fiber) => { fibers.push(fiber); await settleFiber(fiber); };
  try {
    if (!ctx.get('fs')) await mount(ctx.plugin(LocalFileSystem, {}));
    if (!ctx.get('sessionProjections')) await mount(ctx.plugin(SessionProjections));
    await mount(ctx.plugin(WorkingDirectory, { defaultDirectory }));
    return fibers;
  } catch (error) {
    const errors = [error];
    for (const fiber of fibers.reverse()) {
      try { await fiber.dispose(); } catch (cleanup) { errors.push(cleanup); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'DSH working-directory activation and cleanup failed');
    throw error;
  }
}
