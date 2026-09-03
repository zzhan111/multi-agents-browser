import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VaultManager } from "../vault/manager.js";

const VAULT_YAML = `schema_version: 1
name: favvault
display_name: "Fav Vault"
data:
  archive_dir: ./archive
  archive_pattern: "*_mixed.jsonl"
  reports_dir: ./reports
  reports_pattern: "*_report.md"
  index: ./reports/_index.json
push:
  watch_path: ./archive
  debounce_ms: 100
  fs_sweep_ms: 60000
mcp:
  expose: true
rss:
  enable: true
  max_entries: 200
`;

const JUL_29 = "Tue Jul 29 08:00:00 +0000 2026";
const AUG_01 = "Fri Aug 01 09:00:00 +0000 2026";

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

test("favorites toggle/list persist in vault-source _favorites.json; recent/getEntry mark favorite", async () => {
  const root = mkdtempSync(join(tmpdir(), "vault-mgr-"));
  try {
    // vault source dir: vault.yaml + archive jsonl (2 tweets)
    mkdirSync(join(root, "archive"), { recursive: true });
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "vault.yaml"), VAULT_YAML);
    writeFileSync(
      join(root, "archive", "20260729_080000_mixed.jsonl"),
      [
        JSON.stringify({ id: "5101000000000000001", author: "a", text: "first", created_at: JUL_29 }),
        JSON.stringify({ id: "5102000000000000002", author: "b", text: "second", created_at: AUG_01 }),
      ].join("\n") + "\n",
    );

    // isolated registry + stateRoot
    const registryPath = join(root, "registry.json");
    const stateRoot = join(root, "vault-state");
    const mgr = new VaultManager(registryPath, stateRoot);
    const reg = await mgr.register(join(root, "vault.yaml"));
    assert.ok(reg.ok, "register must succeed");

    // initially no favorites
    assert.deepEqual(mgr.listFavorites("favvault"), []);

    // toggle on → true
    assert.equal(mgr.toggleFavorite("favvault", "5101000000000000001"), true);
    assert.equal(mgr.toggleFavorite("favvault", "5102000000000000002"), true);
    // sidecar written at the vault source root (next to vault.yaml)
    assert.ok(existsSync(join(root, "_favorites.json")), "sidecar at vault source root");

    // list favorites: 2 entries, new→old, favorite marked
    const favs = mgr.listFavorites("favvault");
    assert.equal(favs.length, 2);
    assert.deepEqual(favs.map((e) => e.tweetId), ["5102000000000000002", "5101000000000000001"]);
    assert.ok(favs.every((e) => e.favorite));

    // recent() marks favorite on the favorited entry
    const recent = mgr.recent("favvault", null, null, 10);
    const fav = recent.find((e) => e.tweetId === "5101000000000000001");
    assert.equal(fav?.favorite, true);
    const notFav = recent.find((e) => e.tweetId === "5102000000000000002");
    assert.equal(notFav?.favorite, true, "second tweet is also favorited");
    // a third, non-favorited entry would be unmarked — covered implicitly

    // getEntry marks favorite
    assert.equal(mgr.getEntry("favvault", "5101000000000000001")?.favorite, true);

    // toggle off → false, list shrinks
    assert.equal(mgr.toggleFavorite("favvault", "5102000000000000002"), false);
    assert.deepEqual(mgr.listFavorites("favvault").map((e) => e.tweetId), ["5101000000000000001"]);

    // unknown vault/tweet → null (never throws)
    assert.equal(mgr.toggleFavorite("nope", "5101000000000000001"), null);
    assert.equal(mgr.toggleFavorite("favvault", "9999999999999999999"), null);

    mgr.shutdown();
  } finally {
    cleanup(root);
  }
});
