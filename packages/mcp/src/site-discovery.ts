/**
 * Installed-adapter discovery for the MCP site_list/site_search tools (#44).
 *
 * Asks the daemon (with ?invalidate=1, since another process may have just
 * installed the library) and falls back to the local CLI only when the daemon
 * is unreachable and its adapter directories are this machine's: never across
 * a remote or connect-only boundary, and never on an auth or server error.
 * Dependencies are injected so the fallback rules are unit-testable.
 */

import { isAdapterCatalogResult, queryAdapterCatalog } from "@ma-browser/shared";
import type { AdapterCatalogResult, CatalogQuery, DaemonInfo } from "@ma-browser/shared";

/** Loopback daemons share this machine's adapter directories, so the local CLI may answer for them. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export const STALE_DAEMON_HINT =
  "The daemon answered without install status — it predates this MCP server. Restart the daemon (ma-browser daemon stop, then retry) so both run the same version.";

export interface SiteDiscoveryDeps {
  info: DaemonInfo | null;
  connectOnly: boolean;
  /** BB_DAEMON_HOST: a non-loopback override means the catalog lives elsewhere even before daemon.json exists. */
  hostOverride?: string;
  baseUrl: (info: DaemonInfo) => string;
  headers: (info: DaemonInfo) => Record<string, string>;
  /** Runs `ma-browser site list --json` locally. */
  localCatalog: () => Promise<unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export async function discoverSiteCatalog(query: CatalogQuery, deps: SiteDiscoveryDeps): Promise<AdapterCatalogResult> {
  const { info } = deps;
  if (info) {
    const params = new URLSearchParams({ invalidate: "1" });
    if (query.q) params.set("q", query.q);
    if (query.domain) params.set("domain", query.domain);
    const url = `${deps.baseUrl(info)}/api/sites?${params}`;
    let res: globalThis.Response | undefined;
    try {
      res = await (deps.fetch ?? fetch)(url, { headers: deps.headers(info), signal: AbortSignal.timeout(deps.timeoutMs ?? 5000) });
    } catch {
      res = undefined; // unreachable: maybe fall back below
    }
    if (res) {
      if (!res.ok) throw new Error(`Daemon returned HTTP ${res.status} for /api/sites; adapter install status is unknown.`);
      const data: unknown = await res.json();
      if (!isAdapterCatalogResult(data)) throw new Error(STALE_DAEMON_HINT);
      return data;
    }
    if (deps.connectOnly || !isLoopbackHost(info.host)) {
      throw new Error(`Cannot reach the daemon at ${deps.baseUrl(info)}; its adapter catalog lives on that host, so it was not read locally. Check the daemon and retry.`);
    }
  } else if (deps.connectOnly) {
    throw new Error("No daemon found (connect-only mode); adapter install status is unknown. Start the tray and retry.");
  } else if (deps.hostOverride && !isLoopbackHost(deps.hostOverride)) {
    throw new Error(`No daemon info for BB_DAEMON_HOST=${deps.hostOverride}; its adapter catalog lives on that host, so it was not read locally.`);
  }
  const full = await deps.localCatalog();
  if (!isAdapterCatalogResult(full)) {
    throw new Error("The ma-browser CLI returned an adapter list without install status; update it to match this MCP server.");
  }
  // The CLI lists everything; filter here so query/domain behave exactly like the daemon.
  return queryAdapterCatalog(
    { adapters: full.adapters, sources: full.sources, diagnostics: full.diagnostics ?? [], truncated: Boolean(full.truncated) },
    query,
  );
}
