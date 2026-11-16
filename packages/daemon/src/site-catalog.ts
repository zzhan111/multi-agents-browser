/**
 * Site adapter catalog with a short TTL cache, so panel refreshes and agent
 * queries do not rescan the adapter directories on every request.
 *
 * The cache holds the full unfiltered scan (adapters + per-source status), so
 * a query's status is always computed from the whole catalog — never from a
 * previous query's filtered result.
 */

import {
  loadAdapterCatalog,
  queryAdapterCatalog,
  type AdapterCatalog,
  type AdapterCatalogResult,
  type CatalogQuery,
  type SiteAdapter,
} from "@ma-browser/shared";

export type { SiteAdapter };

const CACHE_TTL_MS = 60_000;

let cache: { catalog: AdapterCatalog; builtAt: number } | null = null;

export function getCatalog(): { catalog: AdapterCatalog; adapters: SiteAdapter[]; cacheAge: number } {
  const now = Date.now();
  if (!cache || now - cache.builtAt > CACHE_TTL_MS) cache = { catalog: loadAdapterCatalog(), builtAt: now };
  return { catalog: cache.catalog, adapters: cache.catalog.adapters, cacheAge: Math.floor((now - cache.builtAt) / 1000) };
}

/** Force a cache refresh on next call (e.g. after site_update, or an explicit discovery request). */
export function invalidateCatalog(): void {
  cache = null;
}

/** Query the cached catalog; the result carries install/scan status alongside the matches. */
export function queryCatalog(query: CatalogQuery = {}): AdapterCatalogResult {
  const { catalog, cacheAge } = getCatalog();
  return queryAdapterCatalog(catalog, query, cacheAge);
}
