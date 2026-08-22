// Vault watcher — live FS events (chokidar) + periodic fs_sweep safety net.
//
//   report file written
//        │
//        ├─ chokidar add/change ──► debounce (debounce_ms) ──► indexer.ingestReportFile
//        │                                                          │
//        └─ (missed event?) fs_sweep every fs_sweep_ms ─► stat _index.json mtime
//                                                     └─ changed → reconcile()
//
// Both paths funnel through VaultIndexer.shouldIndex() (mtime watermark), so
// a chokidar event and a sweep firing for the same write index it exactly once.

import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { existsSync, statSync } from "node:fs";
import type { VaultIndexer } from "./indexer.js";
import type { VaultManifest } from "@ma-browser/vault";

export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastIndexMtime = -1;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly manifest: VaultManifest,
    private readonly indexer: VaultIndexer,
    private readonly onNewReport: (reportPath: string, tweetCount: number) => void = () => {},
  ) {}

  start(): void {
    const reportsDir = this.manifest.data.reportsDir; // absolutized by the manager
    if (existsSync(reportsDir)) {
      this.watcher = chokidarWatch(reportsDir, {
        ignoreInitial: true, // startup reconcile() owns the initial pass
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });
      this.watcher.on("add", (p) => this.scheduleReport(p));
      this.watcher.on("change", (p) => this.scheduleReport(p));
    }

    const sweepMs = this.manifest.push.fsSweepMs;
    this.lastIndexMtime = this.indexMtime();
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    // Sweep timer must never keep the daemon process alive on shutdown.
    this.sweepTimer.unref?.();
  }

  /** Debounced per-file ingest; collapses editor/cron write bursts. */
  private scheduleReport(path: string): void {
    if (!path.endsWith(".md")) return;
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(path);
      const n = this.indexer.ingestReportFile(path, []);
      if (n > 0) this.onNewReport(path, n);
    }, this.manifest.push.debounceMs);
    timer.unref?.();
    this.pending.set(path, timer);
  }

  private indexMtime(): number {
    try {
      return statSync(this.manifest.data.index).mtimeMs;
    } catch {
      return -1;
    }
  }

  /** Safety net for missed chokidar events: re-run reconcile on _index.json change. */
  private sweep(): void {
    const m = this.indexMtime();
    if (m > this.lastIndexMtime) {
      this.lastIndexMtime = m;
      void this.indexer.reconcile().catch(() => {});
    }
  }

  stop(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    void this.watcher?.close();
    this.watcher = null;
  }
}
