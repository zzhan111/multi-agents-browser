// Vault feature contract types — the shared vocabulary between daemon
// (runtime implementation in packages/daemon/src/vault/) and tray-app panel.
// Pure types + parsers only: no daemon imports, no React, no side effects.

/**
 * Parsed vault.yaml manifest. Lives at the root of any cron-driven research
 * directory the user registers with `ma-browser vault add <path>`.
 * Field names follow the on-disk YAML (snake_case); this interface is the
 * camelCase projection produced by the zod schema in schema.ts.
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
  orchestrator: {
    type: "hermes" | "openai-compat" | "custom-http";
    baseUrl: string;
    /** Frontmatter path where the orchestrator session id is written (P7). */
    sessionIdPath: string;
    auth: { type: "bearer"; tokenFile?: string; token?: string };
  };
  push: {
    watchPath: string;
    debounceMs: number;
    fsSweepMs: number;
    orchestratorPingMs: number;
  };
  mcp: { expose: boolean };
  rss: { enable: boolean; maxEntries: number };
  ui: { colorAccent?: string; trayBadgeText?: string };
}

/**
 * Report frontmatter (P7). Cron writes this from M3 onward; the ~250 reports
 * written before P7 have no frontmatter at all and parse as schemaVersion 0.
 */
export interface ReportFrontmatter {
  schemaVersion: 1;
  reportTs: string; // ISO 8601
  /** Null for v0 reports — deep-dive falls back to newWithContext. */
  orchestratorSessionId: string | null;
  orchestratorType: string | null;
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
  orchestratorSessionId: string | null;
  orchestratorType: string | null;
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
  hasSession: boolean;
}

/**
 * A tweet (or any primary entity) inside a vault. Tags/notes/processed marks
 * are reduced from the sidecar in M4; PR #1 populates the indexed fields only.
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
  tags: string[]; // reduced from sidecar Pass 1 (M4)
  processedBy: ProcessedMark[]; // append-only, Pass 2 (M4)
  notes: NoteEntry[]; // append-only, Pass 2 (M4)
  deleted: boolean; // Pass 1 (M4)
}

export interface ProcessedMark {
  agent: string;
  ts: string;
  note?: string;
}

export interface NoteEntry {
  noteId: string; // uuid v7
  bodyMd: string;
  author: string;
  ts: string;
}

/**
 * Where a deep-dive request landed. Rendered by the panel as one of three
 * banners: resume (continuing the original session), newWithContext (fresh
 * session with background injection), queued (orchestrator offline).
 */
export type SessionRoute =
  | { kind: "resume"; sessionId: string; orchestratorUrl: string }
  | { kind: "newWithContext"; sessionId: string; orchestratorUrl: string; fallbackReason: string }
  | { kind: "queued"; requestId: string; queuedAt: string };
