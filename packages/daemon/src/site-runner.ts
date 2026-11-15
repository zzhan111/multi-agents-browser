/**
 * Daemon-side adapter lookup and community library updates. Execution lives in
 * command-dispatch (site_run) so it shares sessions, leases and tab queues.
 */

import {
  adapterNotFound,
  updateCommunityAdapters,
  type AdapterCatalogResult,
  type AdapterNotFound,
  type UpdateResult,
} from "@ma-browser/shared";
import { getCatalog, queryCatalog, invalidateCatalog, type SiteAdapter } from "./site-catalog.js";

/** Pull (or clone) the community library, then refresh the catalog. */
export function updateAdapters(): UpdateResult {
  const result = updateCommunityAdapters();
  invalidateCatalog();
  return "error" in result ? result : { ...result, siteCount: getCatalog().adapters.length };
}

/**
 * Explicit discovery rescans: the library may have been installed by another
 * process (e.g. `ma-browser site update` from a terminal), which cannot clear
 * this daemon's in-memory cache.
 */
export function listAdapters(): AdapterCatalogResult {
  invalidateCatalog();
  return queryCatalog();
}

/** Filter the catalog by free-text query and/or domain. */
export function searchAdapters(query?: string, domain?: string): AdapterCatalogResult {
  invalidateCatalog();
  return queryCatalog({ q: query || undefined, domain: domain || undefined });
}

/** Up to 5 fuzzy name suggestions for a missing adapter. */
function fuzzyAdapterNames(name: string): string[] {
  return getCatalog()
    .adapters.filter((a) => a.name.includes(name))
    .slice(0, 5)
    .map((a) => a.name);
}

/**
 * Exact-name lookup. A miss rescans once (the adapter may have just been
 * installed) and then explains why it is missing and how to recover.
 */
export function lookupAdapter(name: string): { adapter: SiteAdapter } | { notFound: AdapterNotFound } {
  let adapter = getCatalog().adapters.find((a) => a.name === name);
  if (!adapter) {
    invalidateCatalog();
    adapter = getCatalog().adapters.find((a) => a.name === name);
  }
  if (adapter) return { adapter };
  return { notFound: adapterNotFound(getCatalog().catalog, name, fuzzyAdapterNames(name)) };
}
