// Vault manager — daemon-side lifecycle owner for all registered vaults.
//
//   startup (daemon Phase 2, detached)          CLI vault register <path>
//        │                                             │
//   loadVaults(registry)                         registerVault(path)
//        │                                             │
//   for each ok manifest ──► VaultIndexer ──► reconcile() ──► VaultWatcher.start()
//        │                                                     (live events + sweep)
//   failed manifests surface as ok:false rows in vault_list
//
// vault.yaml data paths are relative to the manifest's own directory; the
// manager absolutizes them once (withDataDir) so indexer/watcher never
// re-derive.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Entry, Report, ReportHit, VaultManifest } from "@ma-browser/vault";
import { loadVaults, registerVault, vaultPaths, type LoadedVault } from "./discovery.js";
import { VaultIndexer } from "./indexer.js";
import { VaultWatcher } from "./watcher.js";

/** Absolutize the manifest's data-dir-relative paths against vault.yaml's dir. */
function withDataDir(manifest: VaultManifest, manifestDir: string): VaultManifest {
  const abs = (p: string) => (existsSync(p) ? p : join(manifestDir, p));
  return {
    ...manifest,
    data: {
      ...manifest.data,
      archiveDir: abs(manifest.data.archiveDir),
      reportsDir: abs(manifest.data.reportsDir),
      index: abs(manifest.data.index),
      candidates: manifest.data.candidates ? abs(manifest.data.candidates) : undefined,
    },
    push: { ...manifest.push, watchPath: abs(manifest.push.watchPath) },
  };
}

interface LiveVault {
  loaded: LoadedVault;
  manifest: VaultManifest | null;
  indexer: VaultIndexer | null;
  watcher: VaultWatcher | null;
}

export class VaultManager {
  private vaults = new Map<string, LiveVault>();

  constructor(
    registryPath = vaultPaths().registryPath,
    stateRoot = vaultPaths().stateRoot,
  ) {
    this.registryPath = registryPath;
    this.stateRoot = stateRoot;
  }

  private registryPath: string;
  private stateRoot: string;

  /** Load registry, index + watch everything. Safe to call repeatedly. */
  async init(): Promise<void> {
    for (const loaded of loadVaults(this.registryPath)) {
      if (this.vaults.has(loaded.manifestPath)) continue;
      if (!loaded.ok) {
        this.vaults.set(loaded.manifestPath, {
          loaded,
          manifest: null,
          indexer: null,
          watcher: null,
        });
        continue;
      }
      const dataDir = dirname(loaded.manifestPath);
      const manifest = withDataDir(loaded.manifest, dataDir);
      try {
        const indexer = new VaultIndexer(manifest, join(this.stateRoot, manifest.name));
        await indexer.reconcile();
        const watcher = new VaultWatcher(manifest, indexer);
        watcher.start();
        this.vaults.set(loaded.manifestPath, { loaded, manifest, indexer, watcher });
      } catch (e) {
        // One bad vault (locked SQLite, unreadable dir) must not take down the rest.
        this.vaults.set(loaded.manifestPath, {
          loaded,
          manifest: null,
          indexer: null,
          watcher: null,
        });
        console.error(`[Vault] failed to start '${manifest.name}': ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  list(): Array<{
    name: string;
    displayName: string;
    manifestPath: string;
    ok: boolean;
    problem?: string;
    entryCount?: number;
    reportCount?: number;
  }> {
    return Array.from(this.vaults.values()).map((v) => {
      if (!v.indexer || !v.manifest) {
        return {
          name: v.loaded.ok ? v.loaded.manifest.name : v.loaded.manifestPath,
          displayName: v.loaded.ok ? v.loaded.manifest.displayName : v.loaded.manifestPath,
          manifestPath: v.loaded.manifestPath,
          ok: false,
          problem: v.loaded.ok ? "indexer failed to start" : v.loaded.problem,
        };
      }
      const counts = v.indexer.counts();
      return {
        name: v.manifest.name,
        displayName: v.manifest.displayName,
        manifestPath: v.loaded.manifestPath,
        ok: true,
        entryCount: counts.entries,
        reportCount: counts.reports,
      };
    });
  }

  /** Register + immediately index a new vault. Returns its list row. */
  async register(inputPath: string): Promise<
    | { ok: true; row: ReturnType<VaultManager["list"]>[number] }
    | { ok: false; issues: string[] }
  > {
    const r = registerVault(inputPath, this.registryPath);
    if (!r.ok) return r;
    await this.init();
    const row = this.list().find((v) => v.manifestPath === r.manifestPath);
    if (!row) return { ok: false, issues: ["registered but failed to load — check vault.yaml"] };
    return { ok: true, row };
  }

  private find(name: string): { manifest: VaultManifest; indexer: VaultIndexer; manifestPath: string } | null {
    for (const v of this.vaults.values()) {
      if (v.indexer && v.manifest && v.manifest.name === name) {
        return { manifest: v.manifest, indexer: v.indexer, manifestPath: v.loaded.manifestPath };
      }
    }
    return null;
  }

  recent(vaultName: string, sinceIso: string | null, beforeIso: string | null, limit: number, hasReport = false): Entry[] {
      const v = this.find(vaultName);
      if (!v) return [];
      const favs = this.readFavorites(v.manifestPath);
      return v.indexer.recent(sinceIso, beforeIso, limit, hasReport).map((e) =>
        favs.has(e.tweetId) ? { ...e, favorite: true } : e,
      );
    }

  search(vaultName: string | null, query: string, limit: number): ReportHit[] {
    const hits: ReportHit[] = [];
    for (const v of this.vaults.values()) {
      if (!v.indexer || !v.manifest) continue;
      if (vaultName && v.manifest.name !== vaultName) continue;
      if (!v.manifest.mcp.expose) continue; // mcp.expose=false hides from search
      hits.push(...v.indexer.search(query, limit));
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  getReport(vaultName: string, tweetId: string): Report | null {
    const v = this.find(vaultName);
    return v ? v.indexer.getReport(tweetId) : null;
  }

  getEntry(vaultName: string, tweetId: string): Entry | null {
    const v = this.find(vaultName);
    if (!v) return null;
    const e = v.indexer.getEntry(tweetId);
    if (!e) return null;
    return this.readFavorites(v.manifestPath).has(tweetId) ? { ...e, favorite: true } : e;
  }

  /** Resolve vault by name; throws nothing, returns null when unknown. */
  vaultNames(): string[] {
    return this.list().filter((v) => v.ok).map((v) => v.name);
  }

  /** Resolve a loaded manifest by name (null when unknown/broken). */
  manifest(name: string): VaultManifest | null {
    return this.find(name)?.manifest ?? null;
  }

  /** Absolute path of a vault's RSS token file (stateRoot/<name>/rss-token). */
  rssTokenPath(name: string): string {
    return join(this.stateRoot, name, "rss-token");
  }

  /**
   * Read the per-vault RSS Basic Auth token, creating it on first use.
   * The token is the password for the `rss` user on /vault/<name>.xml.
   */
  ensureRssToken(name: string): string {
    const p = this.rssTokenPath(name);
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
    const token = randomBytes(24).toString("hex");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${token}\n`, { mode: 0o600 });
    return token;
  }

  /** Rotate the RSS token and return the new value. */
  rotateRssToken(name: string): string {
    const token = randomBytes(24).toString("hex");
    const p = this.rssTokenPath(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${token}\n`, { mode: 0o600 });
    return token;
  }

  // -------------------------------------------------------------------------
  // Favorites (sidecar _favorites.json at the vault source root)
  // -------------------------------------------------------------------------

  /** Absolute path of a vault's favorites sidecar file (vault source root). */
  private favoritesPath(manifestPath: string): string {
    return join(dirname(manifestPath), "_favorites.json");
  }

  /** Read favorites as a Set of tweetIds. Missing/corrupt file → empty. */
  private readFavorites(manifestPath: string): Set<string> {
    const p = this.favoritesPath(manifestPath);
    if (!existsSync(p)) return new Set();
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as { tweetIds?: unknown };
      if (Array.isArray(parsed.tweetIds)) {
        return new Set(parsed.tweetIds.filter((x): x is string => typeof x === "string"));
      }
    } catch {
      // corrupt sidecar — treat as empty (next toggle rewrites it)
    }
    return new Set();
  }

  /** Persist favorites atomically (tmp + rename). */
  private writeFavorites(manifestPath: string, ids: Set<string>): void {
    const p = this.favoritesPath(manifestPath);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tweetIds: [...ids] }, null, 2) + "\n", "utf-8");
    renameSync(tmp, p);
  }

  /**
   * Toggle a tweet's favorite status. Returns the new state (true = now
   * favorited). Returns null when the vault or tweet is unknown.
   */
  toggleFavorite(name: string, tweetId: string): boolean | null {
    const v = this.find(name);
    if (!v) return null;
    if (!v.indexer.getEntry(tweetId)) return null;
    const ids = this.readFavorites(v.manifestPath);
    let next: boolean;
    if (ids.has(tweetId)) { ids.delete(tweetId); next = false; }
    else { ids.add(tweetId); next = true; }
    this.writeFavorites(v.manifestPath, ids);
    return next;
  }

  /** List favorited entries (new→old), skipping tweets that no longer exist. */
  listFavorites(name: string): Entry[] {
    const v = this.find(name);
    if (!v) return [];
    const ids = this.readFavorites(v.manifestPath);
    const out: Entry[] = [];
    for (const id of ids) {
      const e = v.indexer.getEntry(id);
      if (e) out.push({ ...e, favorite: true });
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  shutdown(): void {
    for (const v of this.vaults.values()) {
      v.watcher?.stop();
      v.indexer?.close();
    }
    this.vaults.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton (one manager per daemon process)
// ---------------------------------------------------------------------------

let singleton: VaultManager | null = null;

export function getVaultManager(): VaultManager {
  if (!singleton) singleton = new VaultManager();
  return singleton;
}

/** Test hook: inject a manager with isolated paths. */
export function setVaultManager(m: VaultManager | null): void {
  singleton = m;
}
