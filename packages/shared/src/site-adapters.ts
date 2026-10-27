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

export function scanSites(dir: string, source: AdapterSource): SiteAdapter[] {
  const found: SiteAdapter[] = [];
  const walk = (current: string) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        try { found.push(parseSiteMeta(readFileSync(full, "utf8"), full, source, dir)); } catch { /* unreadable file */ }
      }
    }
  };
  walk(dir);
  return found;
}

/** All adapters, private overriding community by name, sorted by name. */
export function loadAdapters(localDir = LOCAL_SITES_DIR, communityDir = COMMUNITY_SITES_DIR): SiteAdapter[] {
  const byName = new Map<string, SiteAdapter>();
  for (const adapter of scanSites(communityDir, "community")) byName.set(adapter.name, adapter);
  for (const adapter of scanSites(localDir, "local")) byName.set(adapter.name, adapter);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
