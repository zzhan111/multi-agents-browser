import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseVaultYaml } from "@ma-browser/vault";
import { VaultIndexer, normalizeToIso } from "../vault/indexer.js";

const VAULT_YAML = (name: string) => `schema_version: 1
name: ${name}
display_name: "Test Vault"
data:
  archive_dir: ./archive
  archive_pattern: "*_mixed.jsonl"
  reports_dir: ./reports
  reports_pattern: "*_report.md"
  index: ./reports/_index.json
orchestrator:
  type: hermes
  base_url: http://127.0.0.1:8642
  session_id_path: frontmatter.orchestrator_session_id
  auth:
    type: bearer
    token_file: ~/.hermes/config.yaml
push:
  watch_path: ./reports
  debounce_ms: 100
  fs_sweep_ms: 60000
  orchestrator_ping_ms: 30000
mcp:
  expose: true
rss:
  enable: true
  max_entries: 200
`;

interface Fixture {
  dataDir: string;
  stateDir: string;
}

/** Best-effort temp cleanup: Windows Defender transiently locks fresh files. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Temp-dir garbage is acceptable; assertions already ran.
  }
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vault-idx-"));
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  mkdirSync(join(dataDir, "archive"), { recursive: true });
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { dataDir, stateDir };
}

function makeIndexer(fx: Fixture, name = "testvault"): VaultIndexer {
  const parsed = parseVaultYaml(VAULT_YAML(name));
  if (!parsed.ok) throw new Error(`fixture yaml must parse: ${parsed.issues.join("; ")}`);
  // Simulate the manager's withDataDir: archiveDir/reportsDir/index absolutized.
  const m = parsed.manifest;
  m.data.archiveDir = join(fx.dataDir, "archive");
  m.data.reportsDir = join(fx.dataDir, "reports");
  m.data.index = join(fx.dataDir, "reports", "_index.json");
  return new VaultIndexer(m, fx.stateDir);
}

const JUL_29 = "Tue Jul 29 08:00:00 +0000 2026";
const AUG_01 = "Fri Aug 01 09:00:00 +0000 2026";

function writeBatch(fx: Fixture, fileName: string, tweets: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(fx.dataDir, "archive", fileName),
    tweets.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
}

test("normalizeToIso converts Twitter created_at so lexical sort == chronological", () => {
  const a = normalizeToIso(JUL_29); // "Tue Jul 29 2026"
  const b = normalizeToIso(AUG_01); // "Fri Aug 01 2026"
  // Lexically "Fri..." < "Tue..." — without normalization, recent() would misorder.
  assert.ok(a < b, `${a} must sort before ${b}`);
  assert.equal(a.slice(0, 10), "2026-07-29");
  assert.equal(b.slice(0, 10), "2026-08-01");
});

test("reconcile ingests jsonl entries; counts, search (ascii + CJK), and recent ordering work", async () => {
  const fx = makeFixture();
  try {
    writeBatch(fx, "20260729_080000_mixed.jsonl", [
      { id: "1001", author: "seclink", url: "https://x.com/seclink/status/1001", text: "EverMemOS open-source LLM memory OS", likes: 10, retweets: 1, created_at: JUL_29 },
      { id: "1002", author: "alice", url: "https://x.com/alice/status/1002", text: "百宝箱 长期记忆操作系统对比", likes: 5, retweets: 0, created_at: AUG_01 },
    ]);

    const idx = makeIndexer(fx);
    const r = await idx.reconcile();
    assert.equal(r.entries, 2);
    assert.deepEqual(idx.counts(), { entries: 2, reports: 0 });

    // ascii search with highlight
    const hits = idx.search("EverMemOS");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].tweetId, "1001");
    assert.ok(hits[0].snippet.includes("[EverMemOS]"), `snippet highlights: ${hits[0].snippet}`);

    // CJK search
    const cjk = idx.search("长期记忆");
    assert.equal(cjk.length, 1);
    assert.equal(cjk[0].tweetId, "1002");

    // recent(): Aug 01 first despite "Fri" < "Tue" lexically
        const recent = idx.recent(null, null, 10);
        assert.deepEqual(recent.map((e) => e.tweetId), ["1002", "1001"]);
        assert.equal(recent[0].createdAt.slice(0, 10), "2026-08-01");

        // recent(beforeIso): back-pagination returns the older entries only
            const before = idx.recent(null, "2026-07-30T00:00:00.000Z", 10);
            assert.deepEqual(before.map((e) => e.tweetId), ["1001"]);
            const noneOlder = idx.recent(null, "2026-07-20T00:00:00.000Z", 10);
            assert.equal(noneOlder.length, 0);

    idx.close();
  } finally {
    cleanup(fx.dataDir);
    cleanup(fx.stateDir);
  }
});

test("re-ingesting unchanged files is a no-op (P3 mtime watermark); crash recovery replays only changes", async () => {
  const fx = makeFixture();
  try {
    writeBatch(fx, "20260729_080000_mixed.jsonl", [
      { id: "1001", author: "seclink", text: "hello world", created_at: JUL_29 },
    ]);

    const idx = makeIndexer(fx);
    await idx.reconcile();
    assert.equal(idx.counts().entries, 1);

    // Second reconcile: nothing changed → 0 new, FTS stable.
    const r2 = await idx.reconcile();
    assert.equal(r2.entries, 0);
    assert.equal(idx.search("hello").length, 1);

    // Simulate crash: close (no clean shutdown), reopen from same state dir.
    idx.close();
    const idx2 = makeIndexer(fx);
    const r3 = await idx2.reconcile();
    assert.equal(r3.entries, 0, "unchanged files must not re-index after restart");
    assert.deepEqual(idx2.counts(), { entries: 1, reports: 0 });
    // FTS must not have duplicated rows.
    assert.equal(idx2.search("hello").length, 1);

    // New file lands while daemon was down → exactly it gets replayed.
    writeBatch(fx, "20260801_090000_mixed.jsonl", [
      { id: "1002", author: "bob", text: "second batch", created_at: AUG_01 },
    ]);
    const r4 = await idx2.reconcile();
    assert.equal(r4.entries, 1);
    assert.equal(idx2.counts().entries, 2);

    // Modified file (mtime bump) re-indexes and FTS follows the update.
    const changed = join(fx.dataDir, "archive", "20260729_080000_mixed.jsonl");
    writeBatch(fx, "20260729_080000_mixed.jsonl", [
      { id: "1001", author: "seclink", text: "hello CHANGED", created_at: JUL_29 },
    ]);
    utimesSync(changed, new Date(), new Date(Date.now() + 5000));
    const r5 = await idx2.reconcile();
    assert.equal(r5.entries, 1);
    assert.equal(idx2.search("CHANGED").length, 1);
    assert.equal(idx2.search("world").length, 0, "stale FTS row must be gone");

    idx2.close();
  } finally {
    cleanup(fx.dataDir);
    cleanup(fx.stateDir);
  }
});

test("reports: v0 (no frontmatter, via _index.json) and v1 (frontmatter) both index; getReport reads body", async () => {
  const fx = makeFixture();
  try {
    writeBatch(fx, "20260729_080000_mixed.jsonl", [
      { id: "2001", author: "a", text: "v0 tweet", created_at: JUL_29 },
      { id: "2002", author: "b", text: "v1 tweet", created_at: AUG_01 },
    ]);
    const v0Path = join(fx.dataDir, "reports", "20260729_080500_report.md");
    writeFileSync(v0Path, "# 报告\n\nlegacy body with no frontmatter\n");
    const v1Path = join(fx.dataDir, "reports", "20260801_090500_report.md");
    writeFileSync(
      v1Path,
      `---
schema_version: 1
report_ts: 2026-08-01T09:05:00
orchestrator_session_id: sess_TEST123
orchestrator_type: hermes
vault: testvault
tweet_ids:
  - "2002"
tags: []
---

# 报告 v1

fresh body
`,
    );
    writeFileSync(
      join(fx.dataDir, "reports", "_index.json"),
      JSON.stringify({ "2001": { first_indexed_at: "2026-07-29T08:05:00", report: v0Path } }),
    );

    const idx = makeIndexer(fx);
    await idx.reconcile();
    assert.equal(idx.counts().reports, 2);

    // v0 report: no frontmatter, schema_version 0
    const e0 = idx.getEntry("2001");
    assert.ok(e0?.reportId);
    const r0 = idx.getReport("2001");
    assert.equal(r0?.frontmatter, null);
    assert.ok(r0?.bodyMd.includes("legacy body"));
    assert.equal(r0?.reportTs, "2026-07-29T08:05:00", "report_ts derived from filename");

    // v1 report: frontmatter parsed; legacy orchestrator keys are ignored
    const r1 = idx.getReport("2002");
    assert.equal(r1?.frontmatter?.schemaVersion, 1);
    assert.ok(r1?.bodyMd.includes("fresh body"));
    const hit = idx.search("v1 tweet")[0];
    assert.ok(hit, "search returns the indexed tweet");

    idx.close();
  } finally {
    cleanup(fx.dataDir);
    cleanup(fx.stateDir);
  }
});

test("malformed jsonl lines are skipped without aborting the batch", async () => {
  const fx = makeFixture();
  try {
    writeFileSync(
      join(fx.dataDir, "archive", "20260729_080000_mixed.jsonl"),
      `{"id":"3001","author":"a","text":"good line","created_at":"${JUL_29}"}
{broken json
{"id":"3002","author":"b","text":"also good","created_at":"${AUG_01}"}
`,
    );
    const idx = makeIndexer(fx);
    const r = await idx.reconcile();
    assert.equal(r.entries, 2);
    idx.close();
  } finally {
    cleanup(fx.dataDir);
    cleanup(fx.stateDir);
  }
});

test("getEntry joins latest report; search with bad FTS syntax returns [] instead of throwing", async () => {
  const fx = makeFixture();
  try {
    writeBatch(fx, "20260729_080000_mixed.jsonl", [
      { id: "4001", author: "a", text: "searchable", created_at: JUL_29 },
    ]);
    writeFileSync(
      join(fx.dataDir, "reports", "20260729_080500_report.md"),
      "# r\n\nbody\n",
    );
    writeFileSync(
      join(fx.dataDir, "reports", "_index.json"),
      JSON.stringify({ "4001": { report: join(fx.dataDir, "reports", "20260729_080500_report.md") } }),
    );
    const idx = makeIndexer(fx);
    await idx.reconcile();
    const entry = idx.getEntry("4001");
    assert.ok(entry);
    assert.equal(entry.reportId, "2026-07-29T08:05:00");
    assert.doesNotThrow(() => idx.search('"unbalanced AND ('));
    assert.deepEqual(idx.search('"unbalanced AND ('), []);
    idx.close();
  } finally {
    cleanup(fx.dataDir);
    cleanup(fx.stateDir);
  }
});
