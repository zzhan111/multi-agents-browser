/**
 * Site adapter catalog with a short TTL cache, so panel refreshes and agent
 * queries do not rescan the adapter directories on every request.
 */

import { loadAdapters, type SiteAdapter } from "@ma-browser/shared";

export type { SiteAdapter };

const CACHE_TTL_MS = 60_000;

let cache: { adapters: SiteAdapter[]; builtAt: number } | null = null;

export function getCatalog(): { adapters: SiteAdapter[]; cacheAge: number } {
  const now = Date.now();
  if (!cache || now - cache.builtAt > CACHE_TTL_MS) cache = { adapters: loadAdapters(), builtAt: now };
  return { adapters: cache.adapters, cacheAge: Math.floor((now - cache.builtAt) / 1000) };
}

/** Force a cache refresh on next call (e.g. after site_update). */
export function invalidateCatalog(): void {
  cache = null;
}

export function queryCatalog(adapters: SiteAdapter[], options: { q?: string; domain?: string }): SiteAdapter[] {
  let results = adapters;
  if (options.domain) {
    const d = options.domain.toLowerCase().replace(/^www\./, "");
    results = results.filter((a) => a.domain.toLowerCase().replace(/^www\./, "").includes(d));
  }
  if (options.q) {
    const q = options.q.toLowerCase();
    results = results.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || a.domain.toLowerCase().includes(q));
  }
  return results;
}
