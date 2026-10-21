import type Loader from '@deepseek-ai/cordis-plugin-loader';

export { default as Loader } from '@deepseek-ai/cordis-plugin-loader';
export type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';

/** Wait for owned cleanup even when Loader.remove returns void. */
export async function removeLoaderEntry(loader: Loader, id: string): Promise<void> {
  const fiber = loader.resolve(id).fiber;
  try { await fiber?.dispose(); }
  finally { await loader.root.remove(id); }
}
