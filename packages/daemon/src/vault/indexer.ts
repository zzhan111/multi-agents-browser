// Vault indexer — SQLite + FTS5 over a vault's archive/ and reports/.
//
// Data flow (one vault, one index.sqlite under ~/.bb-browser/vault-state/<name>/):
//
//   archive/*_mixed.jsonl ──line-by-line──► entries ──text/author──► fts_entries
//          (mtime-gated)                     ▲
//                                           │ tweet_id join
//   reports/_index.json ──tweet_id→path──────┤
//   reports/*_report.md ──frontmatter────► reports (schema_version 0|1)
//          (mtime-gated)
//
//   queries: search() → fts MATCH + bm25 rank + snippet()
//            recent() → entries ORDER BY created_at DESC (ISO-normalized)
//            getReport()/getEntry() → row + on-demand file read for bodyMd
//
// Idempotency + crash recovery: every ingested file's mtime is persisted in
// index_state(path, mtime_ms). shouldIndex() consults the in-memory Map first
// (P3 dedup: chokidar and fs_sweep can both fire for one write) and the map
// is seeded from SQLite on open, so a daemon restart replays exactly the
// files that changed while it was down (reconcile()).
//
// created_at arrives in Twitter's native format ("Tue Aug 04 08:29:00 +0000 2026")
// which does NOT sort lexically — normalizeToIso() converts before insert so
// ORDER BY created_at is correct.

import Database from "better-sqlite3";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  parseReportFrontmatter,
  type Entry,
  type Report,
  type ReportHit,
  type VaultManifest,
} from "@ma-browser/vault";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
    tweet_id     TEXT PRIMARY KEY,
    vault        TEXT NOT NULL,
    author       TEXT NOT NULL,
    text         TEXT NOT NULL,
    url          TEXT NOT NULL,
    likes        INTEGER,
    retweets     INTEGER,
    created_at   TEXT NOT NULL,
    indexed_at   TEXT NOT NULL,
    source_file  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_vault_created ON entries(vault, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
    tweet_id                TEXT NOT NULL,
    report_ts               TEXT NOT NULL,
    vault                   TEXT NOT NULL,
    file_path               TEXT NOT NULL,
    orchestrator_session_id TEXT,
    orchestrator_type       TEXT,
    schema_version          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tweet_id, report_ts)
);
CREATE INDEX IF NOT EXISTS idx_reports_session
    ON reports(orchestrator_session_id) WHERE orchestrator_session_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_entries USING fts5(
    tweet_id UNINDEXED,
    text,
    author,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Per-file mtime watermark (the persisted half of the P3 dedup map).
-- Design doc listed this as single meta keys; a per-file table is the
-- correct generalization for 69+ archive batches.
CREATE TABLE IF NOT EXISTS index_state (
    path     TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** "Tue Aug 04 08:29:00 +0000 2026" → "2026-08-04T08:29:00.000Z" (best-effort). */
export function normalizeToIso(raw: string): string {
  const direct = Date.parse(raw);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  // Twitter format: reorder to "Tue Aug 04 2026 08:29:00 GMT+0000" which V8 always parses.
  const m = raw.match(/^[A-Za-z]{3},?\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{4}|[A-Z]+)\s+(\d{4})$/);
  if (m) {
    const [, mon, day, time, zone, year] = m;
    const tz = /^[+-]\d{4}$/.test(zone) ? zone.replace(/(\d{2})(\d{2})/, "$1:$2") : "+00:00";
    const retry = Date.parse(`${mon} ${day}, ${year} ${time} GMT${tz.startsWith("+") ? tz : tz}`);
    if (!Number.isNaN(retry)) return new Date(retry).toISOString();
  }
  return raw; // unparseable → store verbatim; sort quality degrades, never crashes
}

/** Derive report_ts from the cron filename "20260708_085007_report.md". */
function reportTsFromFilename(fileName: string, filePath: string): string {
  const m = fileName.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return new Date(statSync(filePath).mtimeMs).toISOString();
}

interface IndexRow {
  tweet_id: string;
  vault: string;
  author: string;
  text: string;
  url: string;
  likes: number | null;
  retweets: number | null;
  created_at: string;
  indexed_at: string;
}

/**
 * Bare-CJK queries get a prefix star: unicode61 tokenizes a Han run as ONE
 * token (「长期记忆操作系统对比」), so a whole-word query for「长期记忆」can
 * never match. "长期记忆*" does. Queries carrying explicit FTS5 syntax
 * (quotes, *, parens, AND/OR/NOT) pass through untouched — power users keep
 * raw control; ASCII terms stay exact-match (correct for word languages).
 */
function cjkPrefixQuery(query: string): string {
  if (/[*"()]/.test(query) || /\b(AND|OR|NOT)\b/.test(query)) return query;
  const cjk = /[\u3400-\u9fff\uf900-\ufaff]/;
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (cjk.test(t) ? `${t}*` : t))
    .join(" ");
}

export class VaultIndexer {
  private db: Database.Database;
  private mtimeMap = new Map<string, number>();

  constructor(
    public readonly manifest: VaultManifest,
    private readonly stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "index.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const row of this.db.prepare("SELECT path, mtime_ms FROM index_state").all() as Array<{
      path: string;
      mtime_ms: number;
    }>) {
      this.mtimeMap.set(row.path, row.mtime_ms);
    }
  }

  /** P3 dedup gate: true only when the file changed since the last index. */
  shouldIndex(absPath: string): boolean {
    if (!existsSync(absPath)) return true; // deletions flow through reconcile
    const mtime = statSync(absPath).mtimeMs;
    return (this.mtimeMap.get(absPath) ?? -1) < mtime;
  }

  private markIndexed(absPath: string): void {
    const mtime = existsSync(absPath) ? statSync(absPath).mtimeMs : Date.now();
    this.mtimeMap.set(absPath, mtime);
    this.db
      .prepare("INSERT OR REPLACE INTO index_state (path, mtime_ms) VALUES (?, ?)")
      .run(absPath, mtime);
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  /** Stream one JSONL archive batch into entries. Skips malformed lines. */
  async ingestArchiveFile(absPath: string): Promise<number> {
    if (!this.shouldIndex(absPath)) return 0;
    const vault = this.manifest.name;
    const upsert = this.db.prepare(`
      INSERT INTO entries (tweet_id, vault, author, text, url, likes, retweets, created_at, indexed_at, source_file)
      VALUES (@tweet_id, @vault, @author, @text, @url, @likes, @retweets, @created_at, @indexed_at, @source_file)
      ON CONFLICT(tweet_id) DO UPDATE SET
        vault=excluded.vault, author=excluded.author, text=excluded.text, url=excluded.url,
        likes=excluded.likes, retweets=excluded.retweets, created_at=excluded.created_at,
        indexed_at=excluded.indexed_at, source_file=excluded.source_file
    `);
    const ftsDelete = this.db.prepare("DELETE FROM fts_entries WHERE tweet_id = ?");
    const ftsInsert = this.db.prepare("INSERT INTO fts_entries (tweet_id, text, author) VALUES (?, ?, ?)");

    // Stream the file first (memory-safe for large batches), then commit in one tx.
    const lines: string[] = [];
    const rl = createInterface({ input: createReadStream(absPath, "utf-8"), crlfDelay: Infinity });
    await new Promise<void>((resolveDone, reject) => {
      rl.on("error", reject);
      rl.on("line", (l: string) => lines.push(l));
      rl.on("close", () => resolveDone());
    });

    let count = 0;
    this.db.transaction(() => {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const t = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof t.text !== "string") continue; // non-tweet records skipped
          if (t.id === undefined || t.id === null) continue;
          const row: IndexRow = {
            tweet_id: String(t.id),
            vault,
            author: typeof t.author === "string" ? t.author : "unknown",
            text: t.text,
            url: typeof t.url === "string" ? t.url : "",
            likes: typeof t.likes === "number" ? t.likes : null,
            retweets: typeof t.retweets === "number" ? t.retweets : null,
            created_at: normalizeToIso(typeof t.created_at === "string" ? t.created_at : ""),
            indexed_at: new Date().toISOString(),
          };
          upsert.run({ ...row, source_file: absPath });
          ftsDelete.run(row.tweet_id);
          ftsInsert.run(row.tweet_id, row.text, row.author);
          count++;
        } catch {
          // Malformed JSONL line: skip; cron batches are append-only so the
          // next mtime change re-attempts the whole file.
        }
      }
    })();
    this.markIndexed(absPath);
    return count;
  }

  /** Index one report file (frontmatter v0/v1). Returns indexed tweet_ids. */
  ingestReportFile(absPath: string, indexTweetIds: string[]): number {
    if (!this.shouldIndex(absPath)) return 0;
    let md = "";
    try {
      md = readFileSync(absPath, "utf-8");
    } catch {
      return 0; // unreadable file (locked mid-write?) — sweep will retry
    }
    const fm = parseReportFrontmatter(md);
    const reportTs = reportTsFromFilename(absPath.split(/[\\/]/).pop() ?? absPath, absPath);
    const vault = this.manifest.name;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO reports
        (tweet_id, report_ts, vault, file_path, orchestrator_session_id, orchestrator_type, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    this.db.transaction(() => {
      if (fm.ok && fm.schemaVersion === 1 && fm.data) {
        const ids = fm.data.tweetIds.length > 0 ? fm.data.tweetIds : indexTweetIds;
        for (const id of ids) {
          // M3 orchestrator columns: kept in the DB schema for compat with
          // existing index.sqlite files, but always written null (deep-dive removed).
          insert.run(id, reportTs, vault, absPath, null, null, 1);
          n++;
        }
      } else if (fm.ok && fm.schemaVersion === 0) {
        for (const id of indexTweetIds) {
          insert.run(id, reportTs, vault, absPath, null, null, 0);
          n++;
        }
      }
      // !fm.ok (malformed/invalid): file logged via return -1 sentinel below
    })();
    this.markIndexed(absPath);
    return fm.ok ? n : -1;
  }

  /** Read _index.json with the retry ladder (cron mid-write tolerance). */
  private readIndexJson(indexPath: string): Record<string, { report: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return JSON.parse(readFileSync(indexPath, "utf-8")) as Record<string, { report: string }>;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // sleep 100ms without timers
      }
    }
    return {};
  }

  /**
   * Full pass over archive/ + reports/. Manifest data paths must already be
   * absolute (the manager's withDataDir does this; tests likewise) — this
   * method never re-joins them against another root.
   */
  async reconcile(): Promise<{ entries: number; reports: number; files: number }> {
    const archiveDir = this.manifest.data.archiveDir;
    const reportsDir = this.manifest.data.reportsDir;
    let entries = 0;
    let reports = 0;
    let files = 0;

    if (existsSync(archiveDir)) {
      for (const f of readdirSync(archiveDir)) {
        if (!f.includes(this.manifest.data.archivePattern.replace(/\*/g, ""))) continue;
        const p = join(archiveDir, f);
        if (!this.shouldIndex(p)) continue;
        entries += await this.ingestArchiveFile(p);
        files++;
      }
    }

    if (existsSync(reportsDir)) {
      const idx = this.readIndexJson(this.manifest.data.index);
      // tweet_ids grouped per report path (v0 reports have no frontmatter ids).
      // _index.json stores OS-native paths (backslashes on Windows) while our
      // readdir+join builds the other flavor — normalize before keying.
      const norm = (p: string) => p.replace(/\\/g, "/");
      const perFile = new Map<string, string[]>();
      for (const [tweetId, rec] of Object.entries(idx)) {
        if (!rec?.report) continue;
        const key = norm(rec.report);
        const list = perFile.get(key) ?? [];
        list.push(tweetId);
        perFile.set(key, list);
      }
      for (const f of readdirSync(reportsDir)) {
        if (!f.endsWith(".md")) continue;
        const p = join(reportsDir, f);
        if (!this.shouldIndex(p)) continue;
        const n = this.ingestReportFile(p, perFile.get(norm(p)) ?? []);
        if (n > 0) reports += n;
        files++;
      }
    }
    return { entries, reports, files };
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  search(query: string, limit = 20): ReportHit[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT e.tweet_id, e.vault, e.created_at, r.report_ts,
                  snippet(fts_entries, 1, '[', ']', '…', 12) AS snip,
                  bm25(fts_entries) AS score
           FROM fts_entries
           JOIN entries e ON e.tweet_id = fts_entries.tweet_id
           LEFT JOIN reports r ON r.tweet_id = e.tweet_id
           WHERE fts_entries MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(cjkPrefixQuery(query), limit) as Array<{
        tweet_id: string;
        vault: string;
        created_at: string;
        report_ts: string | null;
        snip: string;
        score: number;
      }>;
      return rows.map((r) => ({
        tweetId: r.tweet_id,
        vault: r.vault,
        snippet: r.snip,
        reportTs: r.report_ts ?? r.created_at,
        score: r.score,
      }));
    } catch {
      // Bad FTS5 syntax from the caller — return empty rather than 500-ing the daemon.
      return [];
    }
  }

  recent(sinceIso: string | null, beforeIso: string | null, limit = 50): Entry[] {
      const rows = (
        beforeIso
          ? this.db.prepare(
              "SELECT * FROM entries WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
            ).all(beforeIso, limit)
          : sinceIso
            ? this.db.prepare(
                "SELECT * FROM entries WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
              ).all(sinceIso, limit)
            : this.db.prepare("SELECT * FROM entries ORDER BY created_at DESC LIMIT ?").all(limit)
      ) as Array<IndexRow & { source_file: string }>;
      return rows.map((r) => this.rowToEntry(r));
    }

  getEntry(tweetId: string): Entry | null {
    const r = this.db.prepare("SELECT * FROM entries WHERE tweet_id = ?").get(tweetId) as
      | (IndexRow & { source_file: string })
      | undefined;
    return r ? this.rowToEntry(r) : null;
  }

  private rowToEntry(r: IndexRow & { source_file: string }): Entry {
    const report = this.db
      .prepare("SELECT report_ts FROM reports WHERE tweet_id = ? ORDER BY report_ts DESC LIMIT 1")
      .get(r.tweet_id) as { report_ts: string } | undefined;
    return {
      tweetId: r.tweet_id,
      vault: r.vault,
      author: r.author,
      text: r.text,
      url: r.url,
      likes: r.likes ?? 0,
      retweets: r.retweets ?? 0,
      createdAt: r.created_at,
      indexedAt: r.indexed_at,
      reportId: report?.report_ts ?? null,
    };
  }

  getReport(tweetId: string): Report | null {
    const r = this.db
      .prepare("SELECT * FROM reports WHERE tweet_id = ? ORDER BY report_ts DESC LIMIT 1")
      .get(tweetId) as
      | {
          tweet_id: string;
          report_ts: string;
          vault: string;
          file_path: string;
          schema_version: number;
        }
      | undefined;
    if (!r) return null;
    let bodyMd = "";
    let frontmatter: Report["frontmatter"] = null;
    if (existsSync(r.file_path)) {
      const md = readFileSync(r.file_path, "utf-8");
      const fm = parseReportFrontmatter(md);
      if (fm.ok && fm.schemaVersion === 1) frontmatter = fm.data;
      bodyMd = stripFrontmatter(md);
    } else {
      bodyMd = `(report file missing on disk — moved or deleted: ${r.file_path})`;
    }
    return {
      tweetId: r.tweet_id,
      reportTs: r.report_ts,
      vault: r.vault,
      filePath: r.file_path,
      bodyMd,
      frontmatter,
    };
  }

  counts(): { entries: number; reports: number } {
    const e = this.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    const r = this.db.prepare("SELECT COUNT(DISTINCT tweet_id) AS n FROM reports").get() as { n: number };
    return { entries: e.n, reports: r.n };
  }

  /** Raw mark that a path changed on disk (used by the watcher's fs_sweep). */
  touch(path: string): void {
    this.mtimeMap.delete(path); // force re-index on next pass
  }

  close(): void {
    this.db.close();
  }
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n")) return md;
  const lines = md.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
  }
  return md;
}
