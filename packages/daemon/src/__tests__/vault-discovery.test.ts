import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadVaults, registerVault, vaultPaths } from "../vault/discovery.js";

const VAULT_YAML = (name: string) => `schema_version: 1
name: ${name}
display_name: "Vault ${name}"
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
  auth: { type: bearer }
push:
  watch_path: ./reports
  debounce_ms: 100
  fs_sweep_ms: 60000
  orchestrator_ping_ms: 30000
mcp: { expose: true }
rss: { enable: true, max_entries: 200 }
`;

interface Fx {
  root: string;
  registry: string;
  yamlPath: (name: string) => string;
}

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), "vault-disc-"));
  const registry = join(root, "vault-registry.json");
  return {
    root,
    registry,
    yamlPath: (name: string) => {
      const p = join(root, `${name}-vault.yaml`);
      writeFileSync(p, VAULT_YAML(name));
      return p;
    },
  };
}

/** Best-effort temp cleanup: Windows Defender transiently locks fresh files. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Temp-dir garbage is acceptable; assertions already ran.
  }
}

test("registerVault validates, persists, and loadVaults round-trips", () => {
  const fx = makeFx();
  try {
    const r = registerVault(fx.yamlPath("alpha"), fx.registry);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.manifest.name, "alpha");

    const loaded = loadVaults(fx.registry);
    assert.equal(loaded.length, 1);
    assert.ok(loaded[0].ok);

    // Registry file is valid JSON with the abs path, and no .tmp leftover (atomic write).
    assert.ok(existsSync(fx.registry));
    assert.ok(!existsSync(`${fx.registry}.tmp`));
    const raw = JSON.parse(readFileSync(fx.registry, "utf-8"));
    assert.equal(raw.vaults.length, 1);
  } finally {
    cleanup(fx.root);
  }
});

test("registerVault is idempotent per path and rejects name collisions from other paths", () => {
  const fx = makeFx();
  try {
    const p1 = fx.yamlPath("beta");
    const first = registerVault(p1, fx.registry);
    assert.ok(first.ok && !first.alreadyRegistered, "first register is not 'already'");
    const again = registerVault(p1, fx.registry);
    assert.ok(again.ok && again.alreadyRegistered, "second register of same path is idempotent");

    // Same name, different file → collision rejected.
    const p2 = join(fx.root, "beta2-vault.yaml");
    writeFileSync(p2, VAULT_YAML("beta"));
    const collide = registerVault(p2, fx.registry);
    assert.equal(collide.ok, false);
    if (!collide.ok) assert.ok(collide.issues[0].includes("already registered"));

    // loadVaults still sees exactly one.
    assert.equal(loadVaults(fx.registry).length, 1);
  } finally {
    cleanup(fx.root);
  }
});

test("registerVault rejects missing files and invalid yaml with readable issues", () => {
  const fx = makeFx();
  try {
    const missing = registerVault(join(fx.root, "nope.yaml"), fx.registry);
    assert.equal(missing.ok, false);

    const bad = join(fx.root, "bad-vault.yaml");
    writeFileSync(bad, "schema_version: 1\nname: [oops\n");
    const invalid = registerVault(bad, fx.registry);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.issues.length > 0, true);
  } finally {
    cleanup(fx.root);
  }
});

test("loadVaults surfaces missing manifests as ok:false rows (not fatal)", () => {
  const fx = makeFx();
  try {
    const p = fx.yamlPath("gamma");
    registerVault(p, fx.registry);
    rmSync(p, { force: true });
    const loaded = loadVaults(fx.registry);
    assert.equal(loaded.length, 1);
    assert.ok(!loaded[0].ok);
    if (!loaded[0].ok) assert.ok(loaded[0].problem.includes("not found"));
  } finally {
    cleanup(fx.root);
  }
});

test("vaultPaths honors BB_VAULT_* env overrides (design line 64: BB_VAULT_ prefix)", () => {
  const prevReg = process.env.BB_VAULT_REGISTRY;
  const prevState = process.env.BB_VAULT_STATE_DIR;
  try {
    process.env.BB_VAULT_REGISTRY = "Z:/custom/registry.json";
    process.env.BB_VAULT_STATE_DIR = "Z:/custom/state";
    const p = vaultPaths();
    assert.equal(p.registryPath, "Z:/custom/registry.json");
    assert.equal(p.stateRoot, "Z:/custom/state");
  } finally {
    if (prevReg === undefined) delete process.env.BB_VAULT_REGISTRY;
    else process.env.BB_VAULT_REGISTRY = prevReg;
    if (prevState === undefined) delete process.env.BB_VAULT_STATE_DIR;
    else process.env.BB_VAULT_STATE_DIR = prevState;
  }
});
