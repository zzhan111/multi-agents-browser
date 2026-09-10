/**
 * Site adapter catalog — reads @meta blocks from adapter JS files and serves
 * a queryable catalog. Results are cached for CACHE_TTL_MS to avoid
 * repeated disk I/O on every panel refresh or agent query.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AdapterHealthStatus } from "@ma-browser/shared";
import { healthSortRank } from "./adapter-health.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteAdapter {
  name: string;
  description: string;
  domain: string;
  args: Record<string, { required?: boolean; description?: string }>;
  capabilities?: string[];
  readOnly?: boolean;
  /** Per-adapter TTL override in seconds. 0 = never cache this adapter. */
  cacheTtlSeconds?: number;
  example?: string;
  source: "local" | "community";
  /** @meta.source — freeze drafts set this to "freeze-draft". */
  origin?: string;
  filePath: string;
  // Extended fields for the panel Capabilities tab (legal-compliance + UX).
  /** Human-readable title (e.g. "查看用户推文动态"); falls back to `name`. */
  title?: string;
  /** Category for grouping/filtering: 社交 / 电商 / 出行 / 影视 / 医药 / 工具. */
  category?: string;
  /** Risk level: low / medium / high. */
  risk?: "low" | "medium" | "high";
  /** Usage prerequisites shown to the user (e.g. "需先登录 x.com"). */
  prerequisites?: string;
}

/** Recent-call heat keyed by adapter name. Higher values sort first. */
export type AdapterCallHeat = ReadonlyMap<string, number>;

export interface CatalogQueryOptions {
  q?: string;
  domain?: string;
  /** Optional heat from the daemon's bounded command history ring. */
  recentCallHeat?: AdapterCallHeat;
  /** Optional health by adapter name. Secondary sort key (H5): broken last. */
  healthByName?: ReadonlyMap<string, AdapterHealthStatus>;
}

/** Apply the discovery policy shared by daemon commands and panel APIs. */
export function filterAdaptersForScope(
  adapters: SiteAdapter[],
  readOnlySession: boolean,
): SiteAdapter[] {
  return readOnlySession
    ? adapters.filter((adapter) => adapter.readOnly !== false)
    : adapters;
}

// ---------------------------------------------------------------------------
// @meta parser (mirrors packages/cli/src/commands/site.ts logic)
// ---------------------------------------------------------------------------

function parseMeta(filePath: string, source: "local" | "community"): SiteAdapter | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  // Extract /* @meta ... */ block
  const blockMatch = /\/\*\s*@meta\s*([\s\S]*?)\*\//.exec(content);
  if (!blockMatch) return null;

  const inner = blockMatch[1].trim();

  // Try JSON format first
  try {
    const json = JSON.parse(inner) as {
      name?: string;
      description?: string;
      domain?: string;
      args?: SiteAdapter["args"];
      capabilities?: string[];
      readOnly?: boolean;
      cacheTtlSeconds?: number;
      example?: string;
      source?: string;
      origin?: string;
      title?: string;
      category?: string;
      risk?: SiteAdapter["risk"];
      prerequisites?: string;
    };
    if (!json.name || !json.domain) return null;
    return {
      name: json.name,
      description: json.description ?? "",
      domain: json.domain,
      args: json.args ?? {},
      capabilities: json.capabilities,
      readOnly: json.readOnly,
      cacheTtlSeconds: typeof json.cacheTtlSeconds === "number" && Number.isFinite(json.cacheTtlSeconds)
        ? json.cacheTtlSeconds
        : undefined,
      example: json.example,
      source,
      origin: json.source === "freeze-draft" || json.origin === "freeze-draft"
        ? "freeze-draft"
        : undefined,
      filePath,
      title: json.title,
      category: json.category,
      risk: json.risk,
      prerequisites: json.prerequisites,
    };
  } catch {
    // Fall through to @tag format
  }

  // @tag format: // @name ..., // @domain ..., etc.
  const tag = (key: string) => {
    const m = new RegExp(`//\\s*@${key}[ \\t]+(.*)`, "m").exec(inner);
    return m ? m[1].trim() : undefined;
  };

  const name = tag("name");
  const domain = tag("domain");
  if (!name || !domain) return null;

  return {
    name,
    description: tag("description") ?? "",
    domain,
    args: {},
    readOnly: tag("readOnly") === "true",
    cacheTtlSeconds: (() => {
      const raw = tag("cacheTtlSeconds");
      if (raw === undefined) return undefined;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : undefined;
    })(),
    example: tag("example"),
    source,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

function walkDir(dir: string, source: "local" | "community"): SiteAdapter[] {
  const results: SiteAdapter[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory()) {
      results.push(...walkDir(full, source));
    } else if (entry.endsWith(".js")) {
      const meta = parseMeta(full, source);
      if (meta) results.push(meta);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Catalog with TTL cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

interface Cache {
  adapters: SiteAdapter[];
  builtAt: number;
}

let cache: Cache | null = null;

function buildCatalog(bbHome: string): SiteAdapter[] {
  const local = walkDir(path.join(bbHome, "sites"), "local");
  const community = walkDir(path.join(bbHome, "bb-sites"), "community");

  // Local takes precedence: dedupe by name
  const seen = new Set(local.map((a) => a.name));
  const merged = [...local, ...community.filter((a) => !seen.has(a.name))];
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCatalog(bbHome: string): { adapters: SiteAdapter[]; cacheAge: number } {
  const now = Date.now();
  if (!cache || now - cache.builtAt > CACHE_TTL_MS) {
    cache = { adapters: buildCatalog(bbHome), builtAt: now };
  }
  return { adapters: cache.adapters, cacheAge: Math.floor((now - cache.builtAt) / 1000) };
}

/** Force a cache refresh on next call (e.g. after site_update). */
export function invalidateCatalog(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function queryCatalog(
  adapters: SiteAdapter[],
  options: CatalogQueryOptions,
): SiteAdapter[] {
  let results = adapters;

  if (options.domain) {
    const d = options.domain.toLowerCase().replace(/^www\./, "");
    results = results.filter((a) => a.domain.toLowerCase().replace(/^www\./, "").includes(d));
  }

  if (options.q) {
    const q = options.q.toLowerCase();
    results = results.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.domain.toLowerCase().includes(q),
    );
  }

  const hasHeat = options.recentCallHeat && options.recentCallHeat.size > 0;
  const hasHealth = options.healthByName && options.healthByName.size > 0;
  if (!hasHeat && !hasHealth) return results;

  // Heat is the primary key (command-history). Health is secondary: a broken
  // adapter must not rank above a healthy same-heat (typically same-domain)
  // adapter. Ties keep the catalog's deterministic name order.
  return results
    .map((adapter, index) => ({
      adapter,
      index,
      heat: options.recentCallHeat?.get(adapter.name) ?? 0,
      healthRank: healthSortRank(options.healthByName?.get(adapter.name)),
    }))
    .sort((a, b) => b.heat - a.heat || a.healthRank - b.healthRank || a.index - b.index)
    .map(({ adapter }) => adapter);
}
