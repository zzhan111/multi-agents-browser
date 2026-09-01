// Vault schema + parsers. The single canonical implementation (design Q1):
// daemon's indexer, the panel, the CLI, and MCP tools all import from here.
//
// Contract: every parse function RETURNS a typed result and NEVER throws —
// corrupt or missing input is data, not an exception. The indexer indexes
// ~250 frontmatter-less legacy reports (schemaVersion 0) and must survive
// arbitrary malformed files written by cron mid-crash.

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { ReportFrontmatter, VaultManifest } from "./types.js";

// ---------------------------------------------------------------------------
// vault.yaml
// ---------------------------------------------------------------------------

const vaultManifestYaml = z.object({
  schema_version: z.literal(1),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase kebab-case, used in tab IDs and registry keys"),
  display_name: z.string().min(1),
  data: z.object({
    archive_dir: z.string().min(1),
    archive_pattern: z.string().min(1),
    reports_dir: z.string().min(1),
    reports_pattern: z.string().min(1),
    index: z.string().min(1),
    candidates: z.string().optional(),
  }),
  // Legacy M3 section — accepted for backward compat with existing vault.yaml
  // files, but ignored (deep-dive is removed per minimal design).
  orchestrator: z
    .object({
      type: z.enum(["hermes", "openai-compat", "custom-http"]),
      base_url: z.string().url(),
      session_id_path: z.string().min(1),
      auth: z.object({
        type: z.literal("bearer"),
        token_file: z.string().optional(),
        token: z.string().optional(),
      }),
    })
    .optional(),
  push: z.object({
    watch_path: z.string().min(1),
    debounce_ms: z.number().int().positive(),
    fs_sweep_ms: z.number().int().positive(),
    // Legacy M3 field — accepted for compat, ignored.
    orchestrator_ping_ms: z.number().int().positive().optional(),
  }),
  mcp: z.object({ expose: z.boolean() }),
  rss: z.object({
    enable: z.boolean(),
    max_entries: z.number().int().positive(),
  }),
  ui: z
    .object({
      color_accent: z.string().optional(),
      tray_badge_text: z.string().max(2).optional(),
    })
    .default({}),
});

export type ParseVaultOk = { ok: true; manifest: VaultManifest };
export type ParseVaultErr = {
  ok: false;
  error: "invalid_yaml" | "invalid_schema";
  /** zod issue paths for invalid_schema; YAML error text for invalid_yaml. */
  issues: string[];
};
export type ParseVaultResult = ParseVaultOk | ParseVaultErr;

function projectManifest(raw: z.infer<typeof vaultManifestYaml>): VaultManifest {
  return {
    schemaVersion: raw.schema_version,
    name: raw.name,
    displayName: raw.display_name,
    data: {
      archiveDir: raw.data.archive_dir,
      archivePattern: raw.data.archive_pattern,
      reportsDir: raw.data.reports_dir,
      reportsPattern: raw.data.reports_pattern,
      index: raw.data.index,
      candidates: raw.data.candidates,
    },
    push: {
      watchPath: raw.push.watch_path,
      debounceMs: raw.push.debounce_ms,
      fsSweepMs: raw.push.fs_sweep_ms,
    },
    mcp: raw.mcp,
    rss: { enable: raw.rss.enable, maxEntries: raw.rss.max_entries },
    ui: {
      ...(raw.ui.color_accent !== undefined ? { colorAccent: raw.ui.color_accent } : {}),
      ...(raw.ui.tray_badge_text !== undefined ? { trayBadgeText: raw.ui.tray_badge_text } : {}),
    },
  };
}

/** Parse + validate a vault.yaml document. Never throws. */
export function parseVaultYaml(text: string): ParseVaultResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return {
      ok: false,
      error: "invalid_yaml",
      issues: [e instanceof Error ? e.message : String(e)],
    };
  }
  const parsed = vaultManifestYaml.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_schema",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, manifest: projectManifest(parsed.data) };
}

// ---------------------------------------------------------------------------
// Report frontmatter (P7)
// ---------------------------------------------------------------------------

const frontmatterYaml = z.object({
  schema_version: z.literal(1),
  report_ts: z.string().min(1),
  orchestrator_session_id: z.string().min(1).nullable().default(null),
  orchestrator_type: z.string().min(1).nullable().default(null),
  vault: z.string().min(1),
  tweet_ids: z.array(z.string()).default([]),
  candidate_count: z.number().int().nonnegative().optional(),
  subagent_count: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).default([]),
});

export type ParseFrontmatterOk =
  | { ok: true; schemaVersion: 0; data: null } // legacy report, no frontmatter
  | { ok: true; schemaVersion: 1; data: ReportFrontmatter };
export type ParseFrontmatterErr = { ok: false; error: "malformed_yaml" | "invalid_schema"; issues: string[] };
export type ParseFrontmatterResult = ParseFrontmatterOk | ParseFrontmatterErr;

/**
 * Extract the `---`-delimited YAML block from a report and parse it.
 *
 *   parseReportFrontmatter(md) result map:
 *
 *     md starts with `---\n`?
 *       no  ───────────────────────► { ok, schemaVersion: 0 }   (legacy v0)
 *       yes ── closing `---` line?
 *              no  ───────────────► { error: "malformed_yaml" } (unclosed block)
 *              yes ── YAML parses? ── zod validates?
 *                      no  ───────► { error: "malformed_yaml" }
 *                      yes / no ───► { error: "invalid_schema" }
 *                      yes ────────► { ok, schemaVersion: 1, data }
 *
 * Never throws, for any input — the caller indexes thousands of files written
 * by an external cron pipeline and must treat bad ones as data.
 */
export function parseReportFrontmatter(md: string): ParseFrontmatterResult {
  // Frontmatter is only recognized at byte 0; a `---` later in the body
  // (e.g. a horizontal rule) is prose, not metadata.
  if (!md.startsWith("---\n") && md !== "---") {
    return { ok: true, schemaVersion: 0, data: null };
  }

  const lines = md.split("\n");
  // Find the closing delimiter: a line that is exactly `---` after the opener.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { ok: false, error: "malformed_yaml", issues: ["frontmatter opened but never closed"] };
  }

  const yamlText = lines.slice(1, closeIdx).join("\n");

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return {
      ok: false,
      error: "malformed_yaml",
      issues: [e instanceof Error ? e.message : String(e)],
    };
  }

  const parsed = frontmatterYaml.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid_schema",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  const f = parsed.data;
  return {
    ok: true,
    schemaVersion: 1,
    data: {
      schemaVersion: 1,
      reportTs: f.report_ts,
      vault: f.vault,
      tweetIds: f.tweet_ids,
      candidateCount: f.candidate_count,
      subagentCount: f.subagent_count,
      tags: f.tags,
    },
  };
}
