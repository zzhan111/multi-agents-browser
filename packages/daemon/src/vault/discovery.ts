// Vault discovery — the registry of vault.yaml paths the daemon monitors.
//
// Registry layout (~/.bb-browser/vault-registry.json, atomic writes):
//   { "version": 1, "vaults": ["/abs/path/to/vault.yaml", ...] }
//
// Paths honor the house env conventions: the base dir follows BB_BROWSER_HOME
// like the rest of ma-browser; vault-specific overrides use the BB_VAULT_*
// prefix (design line 64) so tests can point the registry elsewhere.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseVaultYaml, type VaultManifest } from "@ma-browser/vault";

export interface VaultPaths {
  registryPath: string;
  stateRoot: string;
}

export function vaultPaths(): VaultPaths {
  const base = process.env.BB_BROWSER_HOME || join(homedir(), ".bb-browser");
  return {
    registryPath: process.env.BB_VAULT_REGISTRY || resolve(base, "vault-registry.json"),
    stateRoot: process.env.BB_VAULT_STATE_DIR || resolve(base, "vault-state"),
  };
}

interface RegistryFile {
  version: 1;
  vaults: string[];
}

export type LoadedVault =
  | { ok: true; manifest: VaultManifest; manifestPath: string }
  | { ok: false; manifestPath: string; problem: string };

function readRegistry(path: string): RegistryFile {
  if (!existsSync(path)) return { version: 1, vaults: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RegistryFile>;
    if (!Array.isArray(parsed.vaults)) return { version: 1, vaults: [] };
    return { version: 1, vaults: parsed.vaults.filter((p): p is string => typeof p === "string") };
  } catch {
    // Corrupt registry: treat as empty rather than bricking every vault action.
    // The registry only stores paths; re-registering is cheap.
    return { version: 1, vaults: [] };
  }
}

/** Write via tmp + rename so a mid-write crash never corrupts the registry. */
function writeRegistry(path: string, registry: RegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** List every registered vault with its parsed (or failed) manifest. */
export function loadVaults(path?: string): LoadedVault[] {
  const { registryPath } = path ? { registryPath: path } : vaultPaths();
  return readRegistry(registryPath).vaults.map((manifestPath) => {
    if (!existsSync(manifestPath)) {
      return { ok: false as const, manifestPath, problem: "vault.yaml not found on disk" };
    }
    const result = parseVaultYaml(readFileSync(manifestPath, "utf-8"));
    if (!result.ok) {
      return { ok: false as const, manifestPath, problem: `${result.error}: ${result.issues.join("; ")}` };
    }
    return { ok: true as const, manifest: result.manifest, manifestPath };
  });
}

export type RegisterResult =
  | { ok: true; manifest: VaultManifest; manifestPath: string; alreadyRegistered: boolean }
  | { ok: false; issues: string[] };

/** Register a vault.yaml path. Validates before writing; rejects name collisions. */
export function registerVault(inputPath: string, registryPathInput?: string): RegisterResult {
  const { registryPath } = registryPathInput ? { registryPath: registryPathInput } : vaultPaths();
  const manifestPath = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);

  if (!existsSync(manifestPath)) {
    return { ok: false, issues: [`vault.yaml not found at ${manifestPath}`] };
  }
  const parsed = parseVaultYaml(readFileSync(manifestPath, "utf-8"));
  if (!parsed.ok) {
    return { ok: false, issues: parsed.issues };
  }

  const registry = readRegistry(registryPath);
  const existing = loadVaults(registryPath);
  const already = registry.vaults.includes(manifestPath);
  if (!already) {
    for (const e of existing) {
      if (e.ok && e.manifest.name === parsed.manifest.name) {
        return {
          ok: false,
          issues: [
            `vault name '${parsed.manifest.name}' already registered (${e.manifestPath}) — vault names must be unique`,
          ],
        };
      }
    }
    registry.vaults.push(manifestPath);
    writeRegistry(registryPath, registry);
  }
  return { ok: true, manifest: parsed.manifest, manifestPath, alreadyRegistered: already };
}

/** Remove a registry entry by manifest path or vault name. Returns true if removed. */
export function unregisterVault(id: string, registryPathInput?: string): boolean {
  const { registryPath } = registryPathInput ? { registryPath: registryPathInput } : vaultPaths();
  const registry = readRegistry(registryPath);
  const loaded = loadVaults(registryPath);
  const idx = registry.vaults.findIndex((p, i) => p === id || (loaded[i]?.ok && loaded[i].manifest.name === id));
  if (idx === -1) return false;
  registry.vaults.splice(idx, 1);
  writeRegistry(registryPath, registry);
  return true;
}
