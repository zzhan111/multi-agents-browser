/**
 * Site adapter catalog and script preparation, shared by the CLI and daemon.
 *
 * Adapters live outside the repo:
 *   <BB_BROWSER_HOME>/sites/     private adapters (win on name clashes)
 *   <BB_BROWSER_HOME>/bb-sites/  community adapters (`site update`)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { DAEMON_DIR } from "./daemon-client.js";

export type AdapterSource = "local" | "community";

export interface SiteAdapter {
  name: string;
  description: string;
  domain: string;
  args: Record<string, { required?: boolean; description?: string }>;
  capabilities?: string[];
  readOnly?: boolean;
  example?: string;
  source: AdapterSource;
  filePath: string;
}

export const LOCAL_SITES_DIR = join(DAEMON_DIR, "sites");
export const COMMUNITY_SITES_DIR = join(DAEMON_DIR, "bb-sites");

const META_BLOCK = /\/\*\s*@meta\s*([\s\S]*?)\*\//;

/** Parse `/* @meta {json} *\/`, falling back to legacy `// @tag value` lines. */
export function parseSiteMeta(content: string, filePath: string, source: AdapterSource, rootDir: string): SiteAdapter {
  const defaultName = relative(rootDir, filePath).replace(/\.js$/, "").replace(/\\/g, "/");
  const block = content.match(META_BLOCK);
  if (block) {
    try {
      const meta = JSON.parse(block[1]);
      return {
        name: meta.name || defaultName,
        description: meta.description || "",
        domain: meta.domain || "",
        args: meta.args || {},
        capabilities: meta.capabilities,
        readOnly: meta.readOnly,
        example: meta.example,
        source,
        filePath,
      };
    } catch {
      // not JSON: fall through to legacy tags
    }
  }

  const adapter: SiteAdapter = { name: defaultName, description: "", domain: "", args: {}, source, filePath };
  for (const [, key, raw] of content.matchAll(/\/\/\s*@(\w+)[ \t]+(.*)/g)) {
    const value = raw.trim();
    if (key === "name") adapter.name = value;
    else if (key === "description") adapter.description = value;
    else if (key === "domain") adapter.domain = value;
    else if (key === "example") adapter.example = value;
    else if (key === "args") for (const arg of value.split(/[,\s]+/).filter(Boolean)) adapter.args[arg] = { required: true };
  }
  return adapter;
}

// ── Catalog with install/scan status (issue #44) ─────────────────────────────
//
// A bare `[]` used to mean "not installed", "unreadable" and "no match" alike.
// The catalog keeps per-source status so callers can tell them apart.

/** Per-directory state: root absent, readable but no adapters, has adapters, or any read failure. */
export type SourceStatus = "missing" | "empty" | "ok" | "error";

/** Overall state of a (possibly filtered) lookup; priority: degraded > not_installed > empty > no_match > ok. */
export type CatalogStatus = "ok" | "no_match" | "not_installed" | "empty" | "degraded";

export const CATALOG_STATUSES: readonly CatalogStatus[] = ["ok", "no_match", "not_installed", "empty", "degraded"];

export interface CatalogSource {
  source: AdapterSource;
  path: string;
  status: SourceStatus;
  /** Adapters read from this directory, before cross-source de-duplication. */
  adapterCount: number;
  /** Failed read operations (directories or files) in this directory. */
  skipped: number;
}

export interface CatalogDiagnostic {
  source: AdapterSource;
  path: string;
  /** Filesystem errno (EACCES, ENOTDIR, ...) or "EUNKNOWN". */
  code: string;
  error: string;
  hint: string;
  /** Shell command that fixes it, or "" when there is no safe generic fix. */
  action: string;
}

/** Unfiltered scan result; what the daemon caches. */
export interface AdapterCatalog {
  adapters: SiteAdapter[];
  sources: CatalogSource[];
  diagnostics: CatalogDiagnostic[];
  /** True when more read failures occurred than MAX_CATALOG_DIAGNOSTICS. */
  truncated: boolean;
}

/** Shape of site list/search on every surface (HTTP, daemon command, CLI --json, MCP). */
export interface AdapterCatalogResult {
  adapters: SiteAdapter[];
  /** Adapters in the whole catalog (after private-overrides-community), before filtering. */
  total: number;
  /** Seconds since the catalog was scanned; 0 for a fresh scan. */
  cacheAge: number;
  status: CatalogStatus;
  sources: CatalogSource[];
  diagnostics: CatalogDiagnostic[];
  truncated: boolean;
  hint: string;
  /** Shell command to run next, or "". */
  action: string;
}

export const MAX_CATALOG_DIAGNOSTICS = 20;
export const SITE_UPDATE_ACTION = "ma-browser site update";

interface DiagnosticSink {
  add(diagnostic: CatalogDiagnostic): void;
  readonly list: CatalogDiagnostic[];
  readonly truncated: boolean;
}

/** Bounded at collection time so a huge broken tree cannot balloon memory or MCP output. */
function diagnosticSink(limit = MAX_CATALOG_DIAGNOSTICS): DiagnosticSink {
  const list: CatalogDiagnostic[] = [];
  let truncated = false;
  return {
    add(d) { if (list.length < limit) list.push(d); else truncated = true; },
    get list() { return list; },
    get truncated() { return truncated; },
  };
}

function errnoOf(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "EUNKNOWN";
}

function readFailure(source: AdapterSource, path: string, e: unknown): CatalogDiagnostic {
  const code = errnoOf(e);
  const error = e instanceof Error ? e.message : String(e);
  let hint = `Could not read ${path}; check that it is readable.`;
  if (code === "EACCES" || code === "EPERM") hint = `Permission denied reading ${path}; fix its permissions.`;
  else if (code === "ENOTDIR") hint = `${path} is not a directory; move it aside so adapters can be installed there.`;
  return { source, path, code, error, hint, action: "" };
}

/** Filesystem calls used by the scanner; injectable so tests can simulate EACCES on any OS or user. */
export interface CatalogFs {
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
}

const realFs: CatalogFs = { readdirSync, readFileSync };

interface SourceScan { adapters: SiteAdapter[]; info: CatalogSource }

function scanSource(dir: string, source: AdapterSource, sink: DiagnosticSink, fs: CatalogFs): SourceScan {
  const adapters: SiteAdapter[] = [];
  let skipped = 0;
  let rootMissing = false;
  const walk = (current: string, isRoot: boolean) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      // Only a missing root means "not installed"; anything else is a read failure.
      if (isRoot && errnoOf(e) === "ENOENT") { rootMissing = true; return; }
      skipped++;
      sink.add(readFailure(source, current, e));
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(full, false);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        let content: string;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch (e) {
          skipped++;
          sink.add(readFailure(source, full, e));
          continue;
        }
        adapters.push(parseSiteMeta(content, full, source, dir));
      }
    }
  };
  walk(dir, true);
  const status: SourceStatus = rootMissing ? "missing" : skipped > 0 ? "error" : adapters.length > 0 ? "ok" : "empty";
  return { adapters, info: { source, path: dir, status, adapterCount: adapters.length, skipped } };
}

export function scanSites(dir: string, source: AdapterSource): SiteAdapter[] {
  return scanSource(dir, source, diagnosticSink(0), realFs).adapters;
}

/** Scan both libraries (private overrides community by name, sorted by name), keeping per-source status. */
export function loadAdapterCatalog(
  localDir = LOCAL_SITES_DIR,
  communityDir = COMMUNITY_SITES_DIR,
  fs: CatalogFs = realFs,
): AdapterCatalog {
  const sink = diagnosticSink();
  const local = scanSource(localDir, "local", sink, fs);
  const community = scanSource(communityDir, "community", sink, fs);
  const byName = new Map<string, SiteAdapter>();
  for (const adapter of community.adapters) byName.set(adapter.name, adapter);
  for (const adapter of local.adapters) byName.set(adapter.name, adapter);
  return {
    adapters: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sources: [local.info, community.info],
    diagnostics: sink.list,
    truncated: sink.truncated,
  };
}

/** All adapters, private overriding community by name, sorted by name. */
export function loadAdapters(localDir = LOCAL_SITES_DIR, communityDir = COMMUNITY_SITES_DIR): SiteAdapter[] {
  return loadAdapterCatalog(localDir, communityDir).adapters;
}

export interface CatalogQuery { q?: string; domain?: string }

/** Filter by domain (substring, `www.` ignored) and free text over name/description/domain. */
export function filterAdapters(adapters: SiteAdapter[], { q, domain }: CatalogQuery): SiteAdapter[] {
  let results = adapters;
  if (domain) {
    const d = domain.toLowerCase().replace(/^www\./, "");
    results = results.filter((a) => a.domain.toLowerCase().replace(/^www\./, "").includes(d));
  }
  if (q) {
    const needle = q.toLowerCase();
    results = results.filter((a) =>
      a.name.toLowerCase().includes(needle) ||
      a.description.toLowerCase().includes(needle) ||
      a.domain.toLowerCase().includes(needle));
  }
  return results;
}

function communityMissing(catalog: AdapterCatalog): boolean {
  return catalog.sources.some((s) => s.source === "community" && s.status === "missing");
}

/** Status of the unfiltered catalog; no_match is decided per query. */
export function catalogBaseStatus(catalog: AdapterCatalog): Exclude<CatalogStatus, "no_match"> {
  if (catalog.sources.some((s) => s.status === "error")) return "degraded";
  if (catalog.sources.every((s) => s.status === "missing")) return "not_installed";
  if (catalog.adapters.length === 0) return "empty";
  return "ok";
}

function statusAdvice(catalog: AdapterCatalog, status: CatalogStatus): { hint: string; action: string } {
  const paths = catalog.sources.map((s) => s.path).join(" and ");
  switch (status) {
    case "not_installed":
      return {
        hint: `No site adapter library is installed (neither ${paths} exists). Install the community library, then search again. Adapters may still need a logged-in browser session.`,
        action: SITE_UPDATE_ACTION,
      };
    case "empty":
      return communityMissing(catalog)
        ? { hint: `No adapters in ${paths}; the community library is not installed.`, action: SITE_UPDATE_ACTION }
        : { hint: `Adapter directories exist but no adapters were loaded from them (${paths}); check their contents.`, action: "" };
    case "degraded":
      return {
        hint: "Some adapter files or directories could not be read, so these results may be incomplete; see diagnostics.",
        action: "",
      };
    case "no_match":
      return communityMissing(catalog)
        ? { hint: "No installed adapter matches; the community library is not installed and may have one.", action: SITE_UPDATE_ACTION }
        : { hint: "No installed adapter matches this query.", action: "" };
    case "ok":
      return communityMissing(catalog)
        ? { hint: "The community adapter library is not installed; only private adapters are listed.", action: "" }
        : { hint: "", action: "" };
  }
}

/** Apply a query to a catalog snapshot and describe the outcome. */
export function queryAdapterCatalog(catalog: AdapterCatalog, query: CatalogQuery = {}, cacheAge = 0): AdapterCatalogResult {
  const adapters = filterAdapters(catalog.adapters, query);
  const base = catalogBaseStatus(catalog);
  const status: CatalogStatus = base === "ok" && adapters.length === 0 ? "no_match" : base;
  return {
    adapters,
    total: catalog.adapters.length,
    cacheAge,
    status,
    sources: catalog.sources,
    diagnostics: catalog.diagnostics,
    truncated: catalog.truncated,
    ...statusAdvice(catalog, status),
  };
}

export interface AdapterNotFound {
  error: string;
  hint: string;
  action: string;
  status: CatalogStatus;
}

/** Error, recovery hint and action for an exact-name lookup that found nothing. */
export function adapterNotFound(catalog: AdapterCatalog, name: string, suggestions: string[] = []): AdapterNotFound {
  const error = `Site adapter '${name}' not found`;
  const status = catalogBaseStatus(catalog);
  if (status !== "ok") return { error, status, ...statusAdvice(catalog, status) };
  if (suggestions.length) return { error, status, hint: `Did you mean: ${suggestions.join(", ")}?`, action: "" };
  if (communityMissing(catalog)) {
    return { error, status, hint: "The community adapter library is not installed and may provide it.", action: SITE_UPDATE_ACTION };
  }
  return { error, status, hint: "Check the name with site_search; newer community adapters arrive with site update.", action: "" };
}

/** Structural check so clients reject a pre-#44 daemon's bare response instead of misreading it as a status. */
export function isAdapterCatalogResult(value: unknown): value is AdapterCatalogResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.adapters)
    && Array.isArray(v.sources)
    && typeof v.total === "number"
    && typeof v.status === "string"
    && (CATALOG_STATUSES as readonly string[]).includes(v.status);
}

/**
 * Resolve adapter arguments into the IIFE that runs in the page.
 * `--flag value` pairs inside `posArgs` and explicit `namedArgs` fill named
 * slots first; remaining positionals fill the rest in declared order.
 */
export function buildAdapterScript(
  adapter: SiteAdapter,
  posArgs: string[],
  namedArgs: Record<string, string> = {},
): { script: string } | { error: string; missing: string } {
  const argMap: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < posArgs.length; i++) {
    const arg = posArgs[i];
    if (arg.startsWith("--")) {
      const flag = arg.slice(2);
      if (flag in adapter.args && posArgs[i + 1]) argMap[flag] = posArgs[++i];
    } else {
      positional.push(arg);
    }
  }
  for (const [key, value] of Object.entries(namedArgs)) {
    if (key in adapter.args) argMap[key] = value;
  }
  let next = 0;
  for (const name of Object.keys(adapter.args)) {
    if (!argMap[name] && next < positional.length) argMap[name] = positional[next++];
  }
  for (const [name, def] of Object.entries(adapter.args)) {
    if (def.required && !argMap[name]) {
      return { error: `Missing required argument '${name}' for adapter '${adapter.name}'`, missing: name };
    }
  }
  const body = readFileSync(adapter.filePath, "utf8").replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
  return { script: `(${body})(${JSON.stringify(argMap)})` };
}

/** Does a tab's hostname belong to the adapter's domain (or a subdomain)? */
export function matchTabOrigin(tabUrl: string, domain: string): boolean {
  try {
    const host = new URL(tabUrl).hostname;
    return host === domain || host.endsWith("." + domain);
  } catch {
    return false;
  }
}

export const COMMUNITY_REPO = "https://github.com/epiral/bb-sites.git";

export type UpdateResult =
  | { updateMode: "pull" | "clone"; siteCount: number }
  | { updateMode: "pull" | "clone"; error: string; action: string };

/** Pull (or clone) the community adapter repository. Only runs when asked. */
export function updateCommunityAdapters(): UpdateResult {
  mkdirSync(DAEMON_DIR, { recursive: true });
  const updateMode = existsSync(join(COMMUNITY_SITES_DIR, ".git")) ? "pull" : "clone";
  try {
    if (updateMode === "pull") execFileSync("git", ["pull", "--ff-only"], { cwd: COMMUNITY_SITES_DIR, stdio: "pipe" });
    else execFileSync("git", ["clone", COMMUNITY_REPO, COMMUNITY_SITES_DIR], { stdio: "pipe" });
  } catch (e) {
    const action = updateMode === "pull"
      ? `cd ${COMMUNITY_SITES_DIR} && git pull --ff-only`
      : `git clone ${COMMUNITY_REPO} ${COMMUNITY_SITES_DIR}`;
    return { updateMode, error: `site update failed: ${e instanceof Error ? e.message : String(e)}`, action };
  }
  return { updateMode, siteCount: scanSites(COMMUNITY_SITES_DIR, "community").length };
}
