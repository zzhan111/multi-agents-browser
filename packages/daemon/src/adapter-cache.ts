/**
 * Adapter result TTL cache — local-only persistence of successful readOnly
 * site_run JSON. Atomic writes (tmp→rename via StateStore). Never stores a
 * daemon token. Directory: $BB_BROWSER_HOME/cache/adapters/
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import { DAEMON_DIR } from "@ma-browser/shared";
import { StateStore } from "./state-store.js";
import type { SiteAdapter } from "./site-catalog.js";

/** Relative to BB_BROWSER_HOME. Diagnostic zip must skip this tree (K6). */
export const ADAPTER_CACHE_REL_DIR = "cache/adapters";
export const DEFAULT_ADAPTER_CACHE_TTL_SECS = 300;
export const ADAPTER_CACHE_MAX_ENTRIES = 200;
/** Same magnitude as the daemon HTTP body gate (8 MiB). */
export const ADAPTER_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const SECRET_KEYS =
  /^(token|access_token|refresh_token|authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|x-api-key|x-auth-token|x-access-token|apikey)$/i;

export interface AdapterCacheEntry {
  adapterName: string;
  domain: string;
  source: "local" | "community";
  args: Record<string, string>;
  result: unknown;
  capturedAt: string;
  ttlSec: number;
  mtimeMs: number;
  pin?: string;
  tab?: string;
}

export interface AdapterCacheHit {
  entry: AdapterCacheEntry;
  cacheHit: true;
  cacheAgeSec: number;
  cacheExpiresAt: string;
}

export interface AdapterCacheStoreResult {
  stored: boolean;
  reason?: string;
  warning?: string;
  expiresAt?: string;
}

export interface AdapterCacheOptions {
  dir: string;
  now?: () => number;
  getPin?: () => string | undefined;
  defaultTtlSecs?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
}

export function adapterCacheDir(home = DAEMON_DIR): string {
  return path.join(home, ADAPTER_CACHE_REL_DIR);
}

/** True when a diagnostics zip path is inside the adapter cache tree. */
export function isAdapterCacheRelPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return n === ADAPTER_CACHE_REL_DIR || n.startsWith(`${ADAPTER_CACHE_REL_DIR}/`);
}

export function defaultAdapterCacheTtlSecs(
  env: NodeJS.Dict<string> = process.env,
): number {
  const raw = env.BB_ADAPTER_CACHE_TTL_SECS;
  if (raw === undefined || raw === "") return DEFAULT_ADAPTER_CACHE_TTL_SECS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ADAPTER_CACHE_TTL_SECS;
  return n;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

export function adapterCacheKey(
  adapterName: string,
  args: Record<string, string>,
  domain: string,
): string {
  const material = `${adapterName}\0${canonicalJson(args)}\0${domain}`;
  return createHash("sha256").update(material).digest("hex");
}

export function sanitizeCacheResult(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeCacheResult);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = sanitizeCacheResult(v);
  }
  return out;
}

export function isErrorResult(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in (value as Record<string, unknown>)
  );
}

/**
 * Cacheable when the adapter is not an explicit write and the effective TTL
 * is > 0. Missing readOnly is treated as read-only (PRD: readOnly !== false).
 */
export function isAdapterCacheable(
  adapter: Pick<SiteAdapter, "readOnly" | "cacheTtlSeconds">,
  defaultTtlSecs = defaultAdapterCacheTtlSecs(),
): boolean {
  if (adapter.readOnly === false) return false;
  return effectiveTtlSecs(adapter, defaultTtlSecs) > 0;
}

export function effectiveTtlSecs(
  adapter: Pick<SiteAdapter, "cacheTtlSeconds">,
  defaultTtlSecs = defaultAdapterCacheTtlSecs(),
): number {
  if (typeof adapter.cacheTtlSeconds === "number" && Number.isFinite(adapter.cacheTtlSeconds)) {
    return Math.max(0, Math.floor(adapter.cacheTtlSeconds));
  }
  return defaultTtlSecs;
}

function readCommunityPin(): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(DAEMON_DIR, "community-adapters-pin.json"), "utf8"),
    ) as { commit?: unknown };
    return typeof raw.commit === "string" && raw.commit ? raw.commit : undefined;
  } catch {
    return undefined;
  }
}

function fileMtimeMs(filePath: string): number | undefined {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

export class AdapterCache {
  private readonly files: StateStore;
  private readonly now: () => number;
  private readonly getPin: () => string | undefined;
  readonly defaultTtlSecs: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  readonly dir: string;

  constructor(options: AdapterCacheOptions) {
    this.dir = options.dir;
    this.files = new StateStore(options.dir);
    this.now = options.now ?? (() => Date.now());
    this.getPin = options.getPin ?? readCommunityPin;
    this.defaultTtlSecs = options.defaultTtlSecs ?? defaultAdapterCacheTtlSecs();
    this.maxEntries = options.maxEntries ?? ADAPTER_CACHE_MAX_ENTRIES;
    this.maxEntryBytes = options.maxEntryBytes ?? ADAPTER_CACHE_MAX_ENTRY_BYTES;
  }

  lookup(
    adapter: SiteAdapter,
    args: Record<string, string>,
  ): AdapterCacheHit | null {
    if (!isAdapterCacheable(adapter, this.defaultTtlSecs)) return null;
    const key = adapterCacheKey(adapter.name, args, adapter.domain);
    const filename = `${key}.json`;
    const entry = this.files.read<AdapterCacheEntry>(filename);
    if (!entry) return null;
    if (!this.isEntryValid(entry, adapter)) {
      this.removeFile(filename);
      return null;
    }
    const capturedMs = Date.parse(entry.capturedAt);
    const ageSec = Number.isFinite(capturedMs)
      ? Math.max(0, Math.floor((this.now() - capturedMs) / 1000))
      : 0;
    return {
      entry,
      cacheHit: true,
      cacheAgeSec: ageSec,
      cacheExpiresAt: new Date(capturedMs + entry.ttlSec * 1000).toISOString(),
    };
  }

  /**
   * Skip Runtime.evaluate when this returns a hit. `fresh` always bypasses.
   */
  peek(
    adapter: SiteAdapter,
    args: Record<string, string>,
    fresh: boolean,
  ): AdapterCacheHit | null {
    if (fresh) return null;
    return this.lookup(adapter, args);
  }

  store(
    adapter: SiteAdapter,
    args: Record<string, string>,
    result: unknown,
    extra?: { tab?: string },
  ): AdapterCacheStoreResult {
    if (!isAdapterCacheable(adapter, this.defaultTtlSecs)) {
      return { stored: false, reason: "not-cacheable" };
    }
    if (isErrorResult(result)) {
      return { stored: false, reason: "error-result" };
    }
    const mtimeMs = fileMtimeMs(adapter.filePath);
    if (mtimeMs === undefined) {
      return { stored: false, reason: "no-mtime" };
    }
    const ttlSec = effectiveTtlSecs(adapter, this.defaultTtlSecs);
    const capturedAt = new Date(this.now()).toISOString();
    const sanitized = sanitizeCacheResult(result);
    const entry: AdapterCacheEntry = {
      adapterName: adapter.name,
      domain: adapter.domain,
      source: adapter.source,
      args: { ...args },
      result: sanitized,
      capturedAt,
      ttlSec,
      mtimeMs,
      ...(adapter.source === "community"
        ? { pin: this.getPin() }
        : {}),
      ...(extra?.tab ? { tab: extra.tab } : {}),
    };
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, "utf8") > this.maxEntryBytes) {
      return {
        stored: false,
        reason: "too-large",
        warning: `adapter cache skipped: result exceeds ${this.maxEntryBytes} bytes`,
      };
    }
    const key = adapterCacheKey(adapter.name, args, adapter.domain);
    this.files.write(`${key}.json`, entry);
    this.evictOldest();
    return {
      stored: true,
      expiresAt: new Date(this.now() + ttlSec * 1000).toISOString(),
    };
  }

  /** Drop community-sourced entries after a successful site_update (K4). */
  invalidateCommunity(): number {
    return this.removeMatching((entry) => entry.source === "community");
  }

  /** Drop every entry for one adapter name (M3 health=broken hook). */
  invalidateByName(name: string): number {
    return this.removeMatching((entry) => entry.adapterName === name);
  }

  clear(): number {
    return this.removeMatching(() => true);
  }

  count(): number {
    return this.listFilenames().length;
  }

  private isEntryValid(entry: AdapterCacheEntry, adapter: SiteAdapter): boolean {
    const capturedMs = Date.parse(entry.capturedAt);
    if (!Number.isFinite(capturedMs) || entry.ttlSec <= 0) return false;
    if (this.now() >= capturedMs + entry.ttlSec * 1000) return false;
    const mtimeMs = fileMtimeMs(adapter.filePath);
    if (mtimeMs === undefined || mtimeMs !== entry.mtimeMs) return false;
    if (adapter.source === "community") {
      const pin = this.getPin();
      if (entry.pin !== pin) return false;
    }
    return true;
  }

  private evictOldest(): void {
    const files = this.listFilenames();
    if (files.length <= this.maxEntries) return;
    const ranked = files
      .map((filename) => {
        const entry = this.files.read<AdapterCacheEntry>(filename);
        const ts = entry ? Date.parse(entry.capturedAt) : 0;
        return { filename, ts: Number.isFinite(ts) ? ts : 0 };
      })
      .sort((a, b) => a.ts - b.ts);
    const overflow = files.length - this.maxEntries;
    for (let i = 0; i < overflow; i++) {
      this.removeFile(ranked[i].filename);
    }
  }

  private removeMatching(pred: (entry: AdapterCacheEntry) => boolean): number {
    let n = 0;
    for (const filename of this.listFilenames()) {
      const entry = this.files.read<AdapterCacheEntry>(filename);
      if (!entry || pred(entry)) {
        this.removeFile(filename);
        n++;
      }
    }
    return n;
  }

  private listFilenames(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  }

  private removeFile(filename: string): void {
    try {
      unlinkSync(path.join(this.dir, filename));
    } catch {
      /* already gone */
    }
  }
}

let defaultCache: AdapterCache | null = null;

export function getAdapterCache(): AdapterCache {
  if (!defaultCache) {
    defaultCache = new AdapterCache({ dir: adapterCacheDir() });
  }
  return defaultCache;
}

/** Test-only: drop the process-wide singleton. */
export function resetAdapterCacheForTests(): void {
  defaultCache = null;
}
