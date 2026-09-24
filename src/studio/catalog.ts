import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MARKET_URL = 'https://awesome-dsh-plugin.com/plugins.json';
export type CatalogItem = {
  id: string; name: string; origin: 'openclaw' | 'dsh'; kind: string;
  description: string; version?: string; status: string; url?: string; tools?: string[];
};
export type MarketSnapshot = {
  source: string; fetchedAt: string; upstreamUpdated: string; digest: string;
  count: number; items: CatalogItem[]; stale?: boolean; error?: string;
};

export function parseMarket(bytes: string): MarketSnapshot {
  const data = JSON.parse(bytes);
  if (!Array.isArray(data.plugins) || data.plugins.length < 1) throw new Error('市场返回了空目录或无效目录');
  const ids = new Set<string>();
  const items = data.plugins.map((p: Record<string, unknown>): CatalogItem => {
    if (typeof p.name !== 'string' || typeof p.owner !== 'string' || typeof p.url !== 'string') throw new Error('市场条目缺少标识');
    const id = `dsh:market:${p.url}`;
    if (ids.has(id)) throw new Error(`市场条目重复: ${id}`);
    ids.add(id);
    const description = typeof p.description === 'string' ? p.description
      : (p.description as Record<string, string> | undefined)?.zh ?? (p.description as Record<string, string> | undefined)?.en ?? '';
    return { id, name: p.name, origin: 'dsh', kind: 'market', description,
      status: 'available', url: p.url };
  });
  if (typeof data.count === 'number' && data.count !== items.length) throw new Error('市场声明数量与实际条目数量不一致');
  return { source: MARKET_URL, fetchedAt: new Date().toISOString(), upstreamUpdated: String(data.updated ?? ''),
    digest: createHash('sha256').update(bytes).digest('hex'), count: items.length, items };
}

export class MarketCatalog {
  private current?: MarketSnapshot;
  private pending?: Promise<MarketSnapshot>;
  constructor(private readonly stateDir: string) {}
  async get(refresh = false): Promise<MarketSnapshot> {
    if (!refresh && this.current) return this.current;
    if (this.pending) return this.pending;
    this.pending = this.load(refresh).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load(refresh: boolean): Promise<MarketSnapshot> {
    const cache = path.join(this.stateDir, 'market.json');
    if (!this.current) {
      try { this.current = JSON.parse(await readFile(cache, 'utf8')); } catch { /* Fetch the complete source. */ }
    }
    if (!refresh && this.current) return { ...this.current, stale: true };
    try {
      const response = await fetch(MARKET_URL, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`市场请求失败: HTTP ${response.status}`);
      const reader = response.body!.getReader(); let bytes = ''; let size = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 16_000_000) { await reader.cancel(); throw new Error('市场响应超出 16 MB'); }
        bytes += decoder.decode(value, { stream: true });
      }
      bytes += decoder.decode();
      const snapshot = parseMarket(bytes);
      await writeFile(`${cache}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(`${cache}.tmp`, cache);
      this.current = snapshot;
      return snapshot;
    } catch (error) {
      if (this.current) return { ...this.current, stale: true, error: String(error) };
      throw error;
    }
  }
}
