/**
 * Daemon-side adapter lookup and community library updates. Execution lives in
 * command-dispatch (site_run) so it shares sessions, leases and tab queues.
 */

import { updateCommunityAdapters, type UpdateResult } from "@ma-browser/shared";
import { getCatalog, queryCatalog, invalidateCatalog, type SiteAdapter } from "./site-catalog.js";

/** Pull (or clone) the community library, then refresh the catalog. */
export function updateAdapters(): UpdateResult {
  const result = updateCommunityAdapters();
  invalidateCatalog();
  return "error" in result ? result : { ...result, siteCount: getCatalog().adapters.length };
}

/** All adapters in the catalog (local overrides community). */
export function listAdapters(): SiteAdapter[] {
  return getCatalog().adapters;
}

/** Filter the catalog by free-text query and/or domain. */
export function searchAdapters(query?: string, domain?: string): SiteAdapter[] {
  return queryCatalog(getCatalog().adapters, { q: query, domain });
}

/** Exact-name lookup. */
export function findAdapter(name: string): SiteAdapter | undefined {
  return getCatalog().adapters.find((a) => a.name === name);
}

/** Up to 5 fuzzy name suggestions for a missing adapter. */
export function fuzzyAdapterNames(name: string): string[] {
  return getCatalog()
    .adapters.filter((a) => a.name.includes(name))
    .slice(0, 5)
    .map((a) => a.name);
}
