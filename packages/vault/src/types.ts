// Vault feature contract types — the shared vocabulary between daemon
// (runtime implementation in packages/daemon/src/vault/) and tray-app panel.
// Pure types + parsers only: no daemon imports, no React, no side effects.
//
// Trimmed per DESIGN-V5-MINIMAL.md: M3 (deep-dive/orchestrator) and M4
// (sidecar mutations) are gone. This file is the read-only spine: manifests,
// entries, reports, and search hits.

/**
 * Parsed vault.yaml manifest. Lives at the root of any cron-driven research
 * directory the user registers with `ma-browser vault add <path>`.
 * Field names follow the on-disk YAML (snake_case); this interface is the
 * camelCase projection produced by the zod schema in schema.ts.
 * Legacy `orchestrator:` / `push.orchestrator_ping_ms:` keys are accepted
 * and ignored by the parser (they were M3, now removed).
 */
export interface VaultManifest {
  schemaVersion: 1;
  /** Unique per ma-browser install; used in tab IDs and registry keys. */
  name: string;
  displayName: string;
  data: {
    archiveDir: string;
    archivePattern: string;
    reportsDir: string;
    reportsPattern: string;
    index: string;
    candidates?: string;
  };
  push: {
    watchPath: string;
    debounceMs: number;
    fsSweepMs: number;
  };
  mcp: { expose: boolean };
  rss: { enable: boolean; maxEntries: number };
  ui: { colorAccent?: string; trayBadgeText?: string };
}

/**
 * Report frontmatter (P7). Cron writes this from M3 onward; the ~250 reports
 * written before P7 have no frontmatter at all and parse as schemaVersion 0.
 * `orchestrator_session_id` / `orchestrator_type` keys may appear in the
 * YAML (legacy) but are no longer part of the shape — M3 dropped them.
 */
export interface ReportFrontmatter {
  schemaVersion: 1;
  reportTs: string; // ISO 8601
  vault: string;
  tweetIds: string[];
  candidateCount?: number;
  subagentCount?: number;
  tags: string[];
}

/** A single agent-verified report file, indexed by tweet_id. */
export interface Report {
  tweetId: string;
  reportTs: string; // ISO 8601
  vault: string;
  filePath: string;
  bodyMd: string;
  frontmatter: ReportFrontmatter | null;
}

/** One FTS5 search hit with BM25 rank and highlighted snippet. */
export interface ReportHit {
  tweetId: string;
  vault: string;
  snippet: string; // FTS5 highlight
  reportTs: string;
  score: number; // BM25 rank
}

/**
 * A tweet (or any primary entity) inside a vault. M4 sidecar annexation
 * (tags/notes/processed marks) is removed with the mutation surface.
 */
export interface Entry {
  tweetId: string;
  vault: string;
  author: string;
  text: string;
  url: string;
  likes: number;
  retweets: number;
  createdAt: string;
  indexedAt: string;
  reportId: string | null;
  /** true when the user favorited this entry (sidecar _favorites.json). */
  favorite?: boolean;
}
