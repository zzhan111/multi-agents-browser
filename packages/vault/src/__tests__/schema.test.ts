import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVaultYaml, parseReportFrontmatter } from "../schema.js";

// ---------------------------------------------------------------------------
// parseVaultYaml
// ---------------------------------------------------------------------------

const VALID_VAULT_YAML = `schema_version: 1
name: x
display_name: "Twitter/X Research"
data:
  archive_dir: ./archive
  archive_pattern: "*_mixed.jsonl"
  reports_dir: ./reports
  reports_pattern: "*_report.md"
  index: ./reports/_index.json
  candidates: ./reports/_candidates.json
orchestrator:
  type: hermes
  base_url: http://127.0.0.1:8642
  session_id_path: frontmatter.orchestrator_session_id
  auth:
    type: bearer
    token_file: ~/.hermes/config.yaml
push:
  watch_path: ./reports
  debounce_ms: 2000
  fs_sweep_ms: 30000
  orchestrator_ping_ms: 30000
mcp:
  expose: true
rss:
  enable: true
  max_entries: 200
ui:
  color_accent: "#1d9bf0"
  tray_badge_text: "X"
`;

test("parseVaultYaml accepts a complete vault.yaml and projects to camelCase (legacy orchestrator section is accepted + ignored)", () => {
  const r = parseVaultYaml(VALID_VAULT_YAML);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.manifest.schemaVersion, 1);
  assert.equal(r.manifest.name, "x");
  assert.equal(r.manifest.data.archiveDir, "./archive");
  assert.equal(r.manifest.push.fsSweepMs, 30000);
  assert.equal(r.manifest.rss.maxEntries, 200);
  assert.equal(r.manifest.ui.trayBadgeText, "X");
  // M3 remnant: orchestrator section must not leak into the trimmed manifest.
  assert.ok(!("orchestrator" in r.manifest), "no orchestrator field on manifest");
});

test("parseVaultYaml defaults the optional ui block", () => {
  const noUi = VALID_VAULT_YAML.replace(/ui:\n([^]*?)$/, "");
  const r = parseVaultYaml(noUi);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.manifest.ui, {});
});

test("parseVaultYaml reports invalid_schema with a field path for a missing required field", () => {
  const missing = VALID_VAULT_YAML.replace("  index: ./reports/_index.json\n", "");
  const r = parseVaultYaml(missing);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "invalid_schema");
  assert.ok(r.issues.some((i) => i.includes("index")), `issue mentions 'index': ${r.issues}`);
});

test("parseVaultYaml rejects a wrong enum value with the field named", () => {
  const wrongEnum = VALID_VAULT_YAML.replace("type: hermes", "type: wat");
  const r = parseVaultYaml(wrongEnum);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "invalid_schema");
  assert.ok(r.issues.some((i) => i.includes("orchestrator.type")), `issue names orchestrator.type: ${r.issues}`);
});

test("parseVaultYaml accepts a manifest with no orchestrator section at all (M3 removed)", () => {
  const noOrch = VALID_VAULT_YAML
    .replace(/orchestrator:\n([^]*?)push:/, "push:")
    .replace("  orchestrator_ping_ms: 30000\n", "");
  const r = parseVaultYaml(noOrch);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.manifest.name, "x");
  assert.equal(r.manifest.push.fsSweepMs, 30000);
});

test("parseVaultYaml returns invalid_yaml for syntactically broken YAML — and never throws", () => {
  const broken = "name: [unclosed\n  - : :";
  assert.doesNotThrow(() => {
    const r = parseVaultYaml(broken);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "invalid_yaml");
  });
});

test("parseVaultYaml never throws on adversarial inputs", () => {
  // Weird scalars: plain "x" parses as the string x → schema error, not throw.
  for (const input of ["", "x", "42", "null", "---\n- a\n- b", "\t\t", "{["]) {
    assert.doesNotThrow(() => parseVaultYaml(input), `input ${JSON.stringify(input)}`);
  }
});

// ---------------------------------------------------------------------------
// parseReportFrontmatter
// ---------------------------------------------------------------------------

const V1_REPORT = `---
schema_version: 1
report_ts: 2026-06-28T18:08:41
orchestrator_session_id: sess_EXAMPLE0123456789
orchestrator_type: hermes
vault: example
tweet_ids:
  - "0000000000000000001"
  - "0000000000000000002"
candidate_count: 5
subagent_count: 5
tags: []
---

# X 推文跨源调研报告 — 2026-06-28T18:08:41

Body prose follows.
`;

test("parseReportFrontmatter parses a valid v1 frontmatter block (legacy orchestrator keys ignored)", () => {
  const r = parseReportFrontmatter(V1_REPORT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.data?.reportTs, "2026-06-28T18:08:41");
  assert.deepEqual(r.data?.tweetIds, ["0000000000000000001", "0000000000000000002"]);
  assert.equal(r.data?.candidateCount, 5);
  assert.ok(!("orchestratorSessionId" in (r.data ?? {})), "no session field leaks into trimmed frontmatter");
});

test("parseReportFrontmatter returns schemaVersion 0 for the 250 legacy reports with no frontmatter", () => {
  // CRITICAL (design T3): the backcompat path for pre-P7 reports.
  const legacy = "# X 推文跨源调研报告\n\nBody starts immediately.\n";
  const r = parseReportFrontmatter(legacy);
  assert.deepEqual(r, { ok: true, schemaVersion: 0, data: null });
});

test("parseReportFrontmatter ignores a --- horizontal rule in the body (not at byte 0)", () => {
  const withHr = "Intro paragraph.\n\n---\n\nLater section.\n";
  const r = parseReportFrontmatter(withHr);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.schemaVersion, 0);
});

test("parseReportFrontmatter fills defaults for partial frontmatter (missing optional fields)", () => {
  const partial = `---
schema_version: 1
report_ts: 2026-06-28T18:08:41
vault: example
---

# Body
`;
  const r = parseReportFrontmatter(partial);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.schemaVersion, 1);
  assert.deepEqual(r.data?.tweetIds, []);
  assert.deepEqual(r.data?.tags, []);
  assert.equal(r.data?.candidateCount, undefined);
});

test("parseReportFrontmatter returns malformed_yaml for broken YAML inside the block — never throws", () => {
  // CRITICAL (design T3): cron wrote garbage mid-crash; this is data, not an exception.
  const broken = "---\nschema_version: [oops\n  : :\n---\n\nbody\n";
  assert.doesNotThrow(() => {
    const r = parseReportFrontmatter(broken);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "malformed_yaml");
  });
});

test("parseReportFrontmatter returns malformed_yaml for an unclosed frontmatter block", () => {
  const unclosed = "---\nschema_version: 1\nreport_ts: 2026-06-28\n\nbody never closes\n";
  const r = parseReportFrontmatter(unclosed);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "malformed_yaml");
});

test("parseReportFrontmatter returns invalid_schema for wrong-typed frontmatter fields", () => {
  const wrongType = "---\nschema_version: 1\nreport_ts: 2026-06-28\nvault: example\ntweet_ids: not-a-list\n---\n\nbody\n";
  const r = parseReportFrontmatter(wrongType);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "invalid_schema");
});

test("parseReportFrontmatter never throws on adversarial inputs", () => {
  for (const input of ["", "---", "---\n", "---\n---\n", "---\nnull\n---\n", "\n---\nx: 1\n---\n"]) {
    assert.doesNotThrow(() => parseReportFrontmatter(input), `input ${JSON.stringify(input)}`);
  }
});
