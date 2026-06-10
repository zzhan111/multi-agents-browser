/**
 * Site adapter runner — daemon-side execution of site adapters.
 *
 * Mirrors the pure (non-CDP) parts of packages/cli/src/commands/site.ts:siteRun
 * so that `site_run` can be a first-class daemon action. This lets WSL agents
 * (whose MCP only forwards actions over HTTP) run adapters against the same
 * Windows daemon/Chrome that owns the cookies — no CLI, no adapter files on the
 * WSL side. The actual adapter JS executes via the daemon's eval path.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { DAEMON_DIR } from "@ma-browser/shared";
import { getCatalog, queryCatalog, invalidateCatalog, type SiteAdapter } from "./site-catalog.js";

const COMMUNITY_REPO = "https://github.com/epiral/bb-sites.git";
const COMMUNITY_SITES_DIR = path.join(DAEMON_DIR, "bb-sites");

export type UpdateResult =
  | { updateMode: "pull" | "clone"; siteCount: number }
  | { error: string; action: string };

/**
 * Pull (or clone) the community adapter repository and refresh the catalog.
 * Mirrors cli/src/commands/site.ts:siteUpdate, but runs in the daemon process
 * (no stdout; returns a structured result instead).
 */
export function updateAdapters(): UpdateResult {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true });
  } catch { /* dir already exists */ }

  const updateMode = existsSync(path.join(COMMUNITY_SITES_DIR, ".git")) ? "pull" : "clone";
  try {
    if (updateMode === "pull") {
      execSync("git pull --ff-only", { cwd: COMMUNITY_SITES_DIR, stdio: "pipe" });
    } else {
      execSync(`git clone ${COMMUNITY_REPO} ${COMMUNITY_SITES_DIR}`, { stdio: "pipe" });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const action = updateMode === "pull"
      ? `cd ${COMMUNITY_SITES_DIR} && git pull`
      : `git clone ${COMMUNITY_REPO} ${COMMUNITY_SITES_DIR}`;
    return { error: `site_update failed: ${msg}`, action };
  }

  invalidateCatalog();
  const siteCount = getCatalog(DAEMON_DIR).adapters.length;
  return { updateMode, siteCount };
}

/** All adapters in the catalog (local overrides community). */
export function listAdapters(): SiteAdapter[] {
  return getCatalog(DAEMON_DIR).adapters;
}

/** Filter the catalog by free-text query and/or domain. */
export function searchAdapters(query?: string, domain?: string): SiteAdapter[] {
  return queryCatalog(getCatalog(DAEMON_DIR).adapters, { q: query, domain });
}

/** Exact-name lookup. */
export function findAdapter(name: string): SiteAdapter | undefined {
  return getCatalog(DAEMON_DIR).adapters.find((a) => a.name === name);
}

/** Up to 5 fuzzy name suggestions for a missing adapter. */
export function fuzzyAdapterNames(name: string): string[] {
  return getCatalog(DAEMON_DIR)
    .adapters.filter((a) => a.name.includes(name))
    .slice(0, 5)
    .map((a) => a.name);
}

export type PrepareResult = { script: string } | { error: string };

/**
 * Resolve adapter arguments and build the IIFE script that runs the adapter.
 * Argument precedence mirrors the CLI: inline --flags in `posArgs`, then
 * explicit `namedArgs`, then remaining positionals filled in declared order.
 */
export function prepareAdapterScript(
  adapter: SiteAdapter,
  posArgs: string[],
  namedArgs: Record<string, string>,
): PrepareResult {
  const argNames = Object.keys(adapter.args);
  const argMap: Record<string, string> = {};

  // 1. --flag value pairs + collect bare positionals.
  const positional: string[] = [];
  for (let i = 0; i < posArgs.length; i++) {
    const a = posArgs[i];
    if (a.startsWith("--")) {
      const flag = a.slice(2);
      if (flag in adapter.args && posArgs[i + 1] !== undefined) {
        argMap[flag] = posArgs[i + 1];
        i++;
      }
    } else {
      positional.push(a);
    }
  }

  // 2. Explicit named args win over inline flags.
  for (const [k, v] of Object.entries(namedArgs)) {
    if (k in adapter.args) argMap[k] = v;
  }

  // 3. Fill remaining positionals in declared order.
  let p = 0;
  for (const an of argNames) {
    if (argMap[an] === undefined && p < positional.length) argMap[an] = positional[p++];
  }

  // 4. Required-arg check.
  for (const [an, def] of Object.entries(adapter.args)) {
    if (def.required && argMap[an] === undefined) {
      return { error: `Missing required argument '${an}' for adapter '${adapter.name}'` };
    }
  }

  let jsContent: string;
  try {
    jsContent = readFileSync(adapter.filePath, "utf8");
  } catch {
    return { error: `Cannot read adapter file: ${adapter.filePath}` };
  }

  // Strip the /* @meta ... */ block; the remainder is the adapter function.
  const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
  return { script: `(${jsBody})(${JSON.stringify(argMap)})` };
}

/** Does a tab's origin belong to the adapter's domain (or a subdomain)? */
export function matchTabOrigin(tabUrl: string, domain: string): boolean {
  try {
    const host = new URL(tabUrl).hostname;
    return host === domain || host.endsWith("." + domain);
  } catch {
    return false;
  }
}
