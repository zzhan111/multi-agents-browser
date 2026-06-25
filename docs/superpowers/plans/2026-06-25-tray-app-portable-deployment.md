# Tray-App Portable Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a self-contained portable zip (with bundled Node, WebView2 bootstrapper, redesigned icons, and auto-update detection) that an end user can extract and run on a clean Windows 10+ machine.

**Architecture:** The existing Tauri v2 tray-app (`ma-browser-tray.exe`) is a supervisor that spawns a Node.js child process running the daemon. This plan bundles node.exe + daemon + WebView2 bootstrapper as Tauri resources, adds a `pnpm package:win` script to assemble the portable zip, redesigns the icons, unifies the version number to `package.json`, and adds GitHub-Releases-based auto-update detection with manual-replace guidance.

**Tech Stack:** Rust / Tauri v2, reqwest (already transitive in Cargo.lock), Node.js ESM build script, SVG→PNG icon toolchain, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-06-25-tray-app-portable-deployment-design.md`

**Working dir for all paths:** `packages/tray-app` (the Tauri crate lives at `packages/tray-app/src-tauri`). The repo root is two levels up (`../../../`).

**Build/test commands (from `packages/tray-app/src-tauri`):**
- `cargo test --lib` — pure-logic unit tests (no Tauri feature needed)
- `cargo build --features tauri-app --release` — builds the GUI exe
- `pnpm build` (from repo root) — turbo build of all TS packages

---

## File Structure

**New files:**
- `packages/tray-app/src-tauri/src/version.rs` — pure-logic semver parse + compare (Tauri-free, unit-tested)
- `packages/tray-app/src-tauri/src/update_checker.rs` — Tauri-dependent module: `check_latest` (reqwest), `current_version` (env!), `UpdateInfo` struct
- `packages/tray-app/src-tauri/src/webview2_check.rs` — Tauri-dependent: WebView2 install detection + bootstrapper launch
- `packages/tray-app/scripts/package-win.mjs` — the portable-zip build script
- `packages/tray-app/icons/source.svg` — icon source (geometric abstract)
- `packages/tray-app/README.txt`, `packages/tray-app/README-EN.txt` — end-user quick-start
- `packages/tray-app/vendor/MicrosoftEdgeWebview2Setup.exe` — vendored bootstrapper (manual placement, git-tracked)
- `docs/tray-app-packaging.md`, `docs/tray-app-smoke-test.md` — developer docs

**Modified files:**
- `packages/tray-app/src-tauri/build.rs` — extend to read package.json → inject `BB_BROWSER_VERSION`
- `packages/tray-app/src-tauri/Cargo.toml` — add `reqwest`, `serde` features; version-synced
- `packages/tray-app/src-tauri/tauri.conf.json` — `resources` add node/daemon/webview2; version-synced
- `packages/tray-app/src-tauri/src/lib.rs` — declare `version` module
- `packages/tray-app/src-tauri/src/main.rs` — declare `update_checker`, `webview2_check` modules (behind `tauri-app` feature)
- `packages/tray-app/src-tauri/src/app.rs` — startup update check + WebView2 check; new menu items; About version fix
- `packages/tray-app/src-tauri/src/daemon_runner.rs` — `bundled_node_path` priority + `chrome_installed` pre-check
- `packages/tray-app/src-tauri/src/tray_state.rs` — add `update_info` field (controller holds it; see Task 8)
- `packages/tray-app/src-tauri/src/controller.rs` — hold `update_info`, expose to menu builder
- `packages/tray-app/src-tauri/icons/*` — regenerated from SVG
- `packages/tray-app/package.json` — add `package:win` script
- `packages/tray-app/.gitignore` — add `.cache/`, `dist/`
- `packages/tray-app/src-tauri/src/autostart.rs` — no change (menu item hidden in app.rs)

**Decomposition rationale:** Pure-logic (`version.rs`) lives in `lib.rs` so it is unit-testable without the Tauri toolchain, mirroring how `restart_policy`/`port_discovery` are structured. Network/Tauri-dependent code (`update_checker`, `webview2_check`) is behind `#[cfg(feature = "tauri-app")]` in `main.rs`, mirroring `daemon_runner`/`notifier`.

---

## Task 1: Pure-logic version comparison module (TDD)

Create `version.rs` in the lib crate with a `Version` struct (parse `"major.minor.patch"`) and an `is_newer` function. This is Tauri-free so it follows the existing `restart_policy.rs` TDD pattern.

**Files:**
- Create: `packages/tray-app/src-tauri/src/version.rs`
- Modify: `packages/tray-app/src-tauri/src/lib.rs` (add `pub mod version;`)

- [ ] **Step 1: Declare the module in lib.rs**

Edit `packages/tray-app/src-tauri/src/lib.rs`, add `version` to the module list (keep alphabetical order with the existing list):

```rust
pub mod autostart;
pub mod controller;
pub mod daemon_config;
pub mod daemon_spawner;
pub mod port_discovery;
pub mod restart_policy;
pub mod supervisor;
pub mod tray_state;
pub mod version;
```

- [ ] **Step 2: Write the failing tests in version.rs**

Create `packages/tray-app/src-tauri/src/version.rs`:

```rust
//! Pure-logic semver parsing and comparison.
//!
//! Lives in the library crate (Tauri-free) so it can be unit-tested without
//! the GUI toolchain. Only handles clean `major.minor.patch` — no pre-release
//! tags (release tags are conventionally `vX.Y.Z`).

/// Parsed semantic version (major.minor.patch only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    /// Parse `"1.2.3"` or `"v1.2.3"` (strips a leading `v`). Returns `None`
    /// on any malformed input.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().strip_prefix('v').unwrap_or_else(|| s.trim());
        let mut parts = s.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch })
    }
}

/// True when `latest` is strictly newer than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (Version::parse(latest), Version::parse(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_version() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!(v, Version { major: 1, minor: 2, patch: 3 });
    }

    #[test]
    fn strips_leading_v() {
        let v = Version::parse("v0.11.6").unwrap();
        assert_eq!(v, Version { major: 0, minor: 11, patch: 6 });
    }

    #[test]
    fn rejects_too_few_parts() {
        assert!(Version::parse("1.2").is_none());
    }

    #[test]
    fn rejects_too_many_parts() {
        assert!(Version::parse("1.2.3.4").is_none());
    }

    #[test]
    fn rejects_non_numeric() {
        assert!(Version::parse("1.2.x").is_none());
    }

    #[test]
    fn is_newer_true_for_higher_patch() {
        assert!(is_newer("1.2.4", "1.2.3"));
    }

    #[test]
    fn is_newer_true_for_higher_minor() {
        assert!(is_newer("1.3.0", "1.2.9"));
    }

    #[test]
    fn is_newer_false_for_equal() {
        assert!(!is_newer("1.2.3", "1.2.3"));
    }

    #[test]
    fn is_newer_false_for_lower() {
        assert!(!is_newer("1.2.2", "1.2.3"));
    }

    #[test]
    fn is_newer_handles_v_prefix_on_both() {
        assert!(is_newer("v0.12.0", "v0.11.6"));
    }

    #[test]
    fn is_newer_false_on_malformed() {
        assert!(!is_newer("garbage", "1.2.3"));
        assert!(!is_newer("1.2.3", "garbage"));
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run (from `packages/tray-app/src-tauri`):
```
cargo test --lib version
```
Expected: PASS, 11 tests.

- [ ] **Step 4: Commit**

```bash
git add packages/tray-app/src-tauri/src/version.rs packages/tray-app/src-tauri/src/lib.rs
git commit -m "feat(tray-app): pure-logic semver version comparison module"
```

---

## Task 2: build.rs injects BB_BROWSER_VERSION from package.json

Extend the existing `build.rs` to read `../../package.json` (repo root) and emit `cargo:rustc-env=BB_BROWSER_VERSION=<version>`. This makes `env!("BB_BROWSER_VERSION")` available to Rust code.

**Files:**
- Modify: `packages/tray-app/src-tauri/build.rs`

- [ ] **Step 1: Replace build.rs with the extended version**

Edit `packages/tray-app/src-tauri/build.rs` to:

```rust
fn main() {
    // Inject the app version from the repo-root package.json so Rust code can
    // use `env!("BB_BROWSER_VERSION")`. package.json is the single source of
    // truth (the package script also syncs it into Cargo.toml/tauri.conf.json).
    inject_version();

    // Only invoke tauri-build when the tauri-app feature is active.
    // For pure-logic library tests, we skip it entirely.
    #[cfg(feature = "tauri-app")]
    tauri_build::build();
}

fn inject_version() {
    // build.rs runs with CWD = the crate dir (packages/tray-app/src-tauri).
    // The repo root is two levels up.
    let manifest_path = std::path::Path::new("../../package.json");
    let manifest = std::fs::read_to_string(manifest_path)
        .expect("build.rs: cannot read ../../package.json — run from repo root");
    let version = extract_json_string_field(&manifest, "version")
        .expect("build.rs: package.json has no \"version\" string field");
    println!("cargo:rustc-env=BB_BROWSER_VERSION={}", version);
    // Re-run if package.json changes.
    println!("cargo:rerun-if-changed=../../package.json");
}

/// Minimal JSON string-field extractor (avoids pulling a JSON crate into the
/// build script). Looks for `"version"` then the next quoted string.
fn extract_json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\"", field);
    let idx = json.find(&needle)?;
    let rest = &json[idx + needle.len()..];
    let colon = rest.find(':')?;
    let after_colon = &rest[colon + 1..];
    let quote = after_colon.find('"')?;
    let value_start = colon + 1 + quote + 1;
    let value_rest = &json[value_start..];
    let end = value_rest.find('"')?;
    Some(value_rest[..end].to_string())
}
```

- [ ] **Step 2: Verify the env var is injected**

Run (from `packages/tray-app/src-tauri`):
```
cargo build --lib
```
Expected: succeeds (build script runs). To confirm the value, run a one-off check:
```
cargo build --lib -v 2>&1 | findstr BB_BROWSER_VERSION
```
Expected: a line containing `BB_BROWSER_VERSION=0.11.6` (or whatever package.json currently says).

- [ ] **Step 3: Commit**

```bash
git add packages/tray-app/src-tauri/build.rs
git commit -m "feat(tray-app): inject BB_BROWSER_VERSION from package.json in build.rs"
```

---

## Task 3: update_checker module (current_version + UpdateInfo)

Create the `update_checker.rs` module behind `#[cfg(feature = "tauri-app")]`. It re-exports `version::is_newer`/`Version`, defines `UpdateInfo`, exposes `current_version()` via `env!`, and implements `check_latest` with reqwest. The network call is the one part not unit-testable here; the pure helpers (`is_newer`, `Version::parse`) are already covered by Task 1.

**Files:**
- Create: `packages/tray-app/src-tauri/src/update_checker.rs`
- Modify: `packages/tray-app/src-tauri/src/main.rs` (declare module)
- Modify: `packages/tray-app/src-tauri/Cargo.toml` (add reqwest, serde features)

- [ ] **Step 1: Add reqwest + serde features to Cargo.toml**

Edit `packages/tray-app/src-tauri/Cargo.toml`. In the `[dependencies]` section (after the existing `serde_json = "1.0"` line), add:

```toml
reqwest = { version = "0.13", default-features = false, features = ["json", "rustls-tls"] }
```

Note: `reqwest` 0.13 is already in `Cargo.lock` transitively (Tauri pulls it at 0.13.3), so this just promotes it to a direct dep with minimal features — no second reqwest version is introduced. `serde` is already a dependency with `derive`.

- [ ] **Step 2: Declare the module in main.rs**

Edit `packages/tray-app/src-tauri/src/main.rs`. Add `update_checker` to the `#[cfg(feature = "tauri-app")] mod` block (after `notifier`):

```rust
#[cfg(feature = "tauri-app")]
mod app;
#[cfg(feature = "tauri-app")]
mod commands;
#[cfg(feature = "tauri-app")]
mod daemon_runner;
#[cfg(feature = "tauri-app")]
mod notifier;
#[cfg(feature = "tauri-app")]
mod update_checker;
```

- [ ] **Step 3: Write update_checker.rs**

Create `packages/tray-app/src-tauri/src/update_checker.rs`:

```rust
//! GitHub-Releases-based update detection.
//!
//! Detects a newer release than the running build and exposes enough info
//! (latest version, release URL, asset download URL) for the tray menu to
//! surface a "🆕 有新版本 vX.Y.Z" item. There is NO auto-download/file-swap —
//! the user is guided to manually replace the portable zip (see spec §8).
//!
//! All network failures are silent (`check_latest` returns `None`) so an
//! unreachable GitHub never affects startup or the core daemon/Chrome path.

use ma_browser_tray::version::{is_newer, Version};
use serde::Deserialize;
use std::time::Duration;

/// GitHub repo that hosts releases (owner/name).
pub const RELEASE_REPO: &str = "zzhan111/multi-agents-browser";

/// Resolved info about a newer release.
#[derive(Debug, Clone)]
pub struct UpdateInfo {
    /// Latest version, e.g. "0.12.0" (no leading `v`).
    pub latest_version: String,
    /// Browser-facing release page URL.
    pub release_url: String,
    /// Direct download URL for the portable zip asset (first .zip asset).
    pub download_url: Option<String>,
}

/// Current app version, injected at build time from package.json.
pub fn current_version() -> &'static str {
    env!("BB_BROWSER_VERSION")
}

/// True when `latest` is strictly newer than the running build.
pub fn is_update_available(latest: &str) -> bool {
    is_newer(latest, current_version())
}

/// Fetch the latest release from GitHub. Returns `None` on ANY failure
/// (network, non-200, parse, rate-limit) — callers must treat this as
/// "feature unavailable", never an error.
pub async fn check_latest(repo: &str) -> Option<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let client = reqwest::Client::builder()
        .user_agent("ma-browser-tray-updater")
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: GithubRelease = resp.json().await.ok()?;
    // tag_name is conventionally "vX.Y.Z"; strip the leading `v`.
    let latest_version = body.tag_name.strip_prefix('v').unwrap_or(&body.tag_name).to_string();
    // Validate it parses before reporting (a malformed tag is not an update).
    Version::parse(&latest_version)?;
    let download_url = body
        .assets
        .iter()
        .find(|a| a.name.ends_with(".zip"))
        .map(|a| a.browser_download_url.clone());
    Some(UpdateInfo {
        latest_version,
        release_url: body.html_url,
        download_url,
    })
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}
```

- [ ] **Step 4: Verify it compiles**

Run (from `packages/tray-app/src-tauri`):
```
cargo build --features tauri-app
```
Expected: succeeds. (Do NOT add a network unit test here — GitHub calls are non-deterministic; the smoke test in Task 12 covers the live path. The pure logic is already tested in Task 1.)

- [ ] **Step 5: Commit**

```bash
git add packages/tray-app/src-tauri/src/update_checker.rs packages/tray-app/src-tauri/src/main.rs packages/tray-app/src-tauri/Cargo.toml packages/tray-app/src-tauri/Cargo.lock
git commit -m "feat(tray-app): GitHub Releases update checker module"
```

---

## Task 4: webview2_check module

Create `webview2_check.rs` behind `#[cfg(feature = "tauri-app")]`. It checks the WebView2 runtime registry key and, if absent, shows a native MessageBox + launches the bundled `MicrosoftEdgeWebview2Setup.exe`.

**Files:**
- Create: `packages/tray-app/src-tauri/src/webview2_check.rs`
- Modify: `packages/tray-app/src-tauri/src/main.rs` (declare module)

- [ ] **Step 1: Declare the module in main.rs**

Edit `packages/tray-app/src-tauri/src/main.rs`, add `webview2_check` to the `#[cfg(feature = "tauri-app")] mod` block:

```rust
#[cfg(feature = "tauri-app")]
mod update_checker;
#[cfg(feature = "tauri-app")]
mod webview2_check;
```

- [ ] **Step 2: Write webview2_check.rs**

Create `packages/tray-app/src-tauri/src/webview2_check.rs`:

```rust
//! Pre-start WebView2 Runtime check.
//!
//! Tauri depends on WebView2 (pre-installed on Win11, may be absent on Win10).
//! When missing, Tauri fails ungracefully. This module checks the official
//! registry key and, if absent, prompts the user via a native MessageBox and
//! launches the bundled Evergreen Bootstrapper (MicrosoftEdgeWebview2Setup.exe
//! shipped as a Tauri resource alongside the exe).

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The WebView2 client registry value name (per Microsoft docs).
const WEBVIEW2_REG_KEY: &str = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BFF-9B32BFE3D7A8}";
const WEBVIEW2_REG_VALUE: &str = "pv";

/// True if a WebView2 runtime is installed (any non-empty `pv` value).
pub fn is_installed() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let Ok(key) = hklm.open_subkey(WEBVIEW2_REG_KEY) else {
            return false;
        };
        let pv: Option<String> = key.get_value(WEBVIEW2_REG_VALUE).ok();
        matches!(pv, Some(v) if !v.is_empty())
    }
    #[cfg(not(windows))]
    {
        true // non-Windows: no WebView2 concept; assume present.
    }
}

/// If WebView2 is missing, prompt the user and launch the bootstrapper.
/// Returns true if a bootstrapper was launched (caller should exit so the
/// installer can run + the user can restart the app).
pub fn ensure_installed(app: &AppHandle) -> bool {
    if is_installed() {
        return false;
    }
    let bootstrapper = bundled_bootstrapper_path(app);
    eprintln!(
        "[webview2] WebView2 Runtime not found; bootstrapper at {:?}",
        bootstrapper
    );
    // Native MessageBox via tauri-plugin-dialog.
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let accepted = std::sync::atomic::AtomicBool::new(false);
    let accepted_ref = &accepted;
    app.dialog()
        .message(
            "运行本程序需要 WebView2 Runtime,当前未检测到。\n\
             点击“确定”自动安装(需联网),安装完成后请重新启动本程序。",
        )
        .title("缺少 WebView2 Runtime")
        .kind(MessageDialogKind::Warning)
        .show(|ok| {
            accepted_ref.store(ok, std::sync::atomic::Ordering::SeqCst);
        });
    // `show` with a callback is non-blocking on Windows; the dialog blocks the
    // UI thread in practice for a modal. Use a blocking variant to be safe.
    let accepted = accepted.load(std::sync::atomic::Ordering::SeqCst);
    if accepted {
        if let Some(path) = bootstrapper {
            // Launch silently-ish; the Evergreen bootstrapper installs per-user.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = std::process::Command::new(&path)
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new(&path).spawn();
            }
            return true;
        }
    }
    false
}

fn bundled_bootstrapper_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let candidate = dir.join("MicrosoftEdgeWebview2Setup.exe");
    candidate.exists().then_some(candidate)
}
```

- [ ] **Step 3: Verify it compiles**

Run (from `packages/tray-app/src-tauri`):
```
cargo build --features tauri-app
```
Expected: succeeds. (`winreg` is already a Windows dependency in `Cargo.toml`.)

- [ ] **Step 4: Commit**

```bash
git add packages/tray-app/src-tauri/src/webview2_check.rs packages/tray-app/src-tauri/src/main.rs
git commit -m "feat(tray-app): WebView2 runtime pre-check + bootstrapper launch"
```

---

## Task 5: Bundled node + Chrome pre-check in daemon_runner

Modify `daemon_runner.rs::build_spawn_config` to prefer the bundled node (`resource_dir/node/node.exe`) over `which::which("node")`, and add a `chrome_installed()` pre-check so a missing Chrome produces a clear message instead of a vague daemon exit.

**Files:**
- Modify: `packages/tray-app/src-tauri/src/daemon_runner.rs`

- [ ] **Step 1: Add bundled_node_path helper**

Edit `packages/tray-app/src-tauri/src/daemon_runner.rs`. Add this helper near `locate_daemon_entry` (after it, around the existing "Spawn config builder" section):

```rust
/// Locate the bundled `node.exe` under the Tauri resource dir. Returns `None`
/// in dev (no bundled node) — caller falls back to `which::which("node")`.
fn bundled_node_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let candidate = dir.join("node").join("node.exe");
    candidate.exists().then_some(candidate)
}
```

- [ ] **Step 2: Change build_spawn_config to prefer bundled node**

In `build_spawn_config`, replace the node-resolution block. The current code (around `daemon_runner.rs:268-275`) resolves `node_abs` via `which::which("node")` for validation but spawns the bare name `"node"`. Change it to prefer the bundled absolute path and only fall back to the bare name:

Replace the block starting with `let node_abs = which::which("node")` through the `eprintln!("[runner] resolved daemon entry...` line, so the resolution becomes:

```rust
    // Prefer the bundled node.exe (portable install); fall back to system PATH
    // (dev, or a user who has Node installed). The bundled path is an absolute
    // path and is spawned directly; the fallback uses the bare name "node" so
    // Windows Command does a PATH search (reliable even when the absolute path
    // would contain spaces — see the existing comment in spawn()).
    let bundled = bundled_node_path(app);
    let node_program: PathBuf = if let Some(p) = bundled.clone() {
        eprintln!("[runner] using bundled node: {p:?}");
        p
    } else {
        // Verify node exists on PATH (clear error if not) — validation only;
        // we still spawn the bare name for the PATH-search reliability noted
        // above.
        match which::which("node") {
            Ok(abs) => {
                eprintln!("[runner] node on PATH: {abs:?} (spawning bare name)");
                PathBuf::from("node")
            }
            Err(e) => return Err(format!("node not on PATH and no bundled node: {e}")),
        }
    };
    let daemon_entry = locate_daemon_entry(app)?;
    eprintln!(
        "[runner] resolved daemon entry: {daemon_entry:?} (exists={})",
        daemon_entry.exists()
    );
```

Then, further down in the same function, change the `SpawnConfig` construction so `program: PathBuf::from("node")` becomes `program: node_program`. The full final `Ok(SpawnConfig { ... })` block:

```rust
    Ok(SpawnConfig {
        program: node_program,
        args: vec![
            entry_str,
            "--host".into(),
            "0.0.0.0".into(),
            "--port".into(),
            daemon.to_string(),
            "--cdp-port".into(),
            cdp.to_string(),
        ],
        cwd: None,
        env: vec![("BB_BROWSER_HOME".to_string(), bb_home)],
        ready_timeout: DEFAULT_READY_TIMEOUT,
    })
```

- [ ] **Step 3: Add chrome_installed pre-check**

Add this function near the top of the "Spawn config builder" section:

```rust
/// True if Google Chrome appears to be installed. Checks the two standard
/// install locations + the registry. Used to give a clear message before a
/// doomed daemon spawn (the daemon connects to the user's real Chrome).
fn chrome_installed() -> bool {
    use std::path::PathBuf;
    // 1. Program Files (system-wide)
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from);
    if let Some(p) = pf.as_ref() {
        let candidate = p.join("Google").join("Chrome").join("Application").join("chrome.exe");
        if candidate.exists() {
            return true;
        }
    }
    // 2. LOCALAPPDATA (per-user install)
    let lad = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    if let Some(p) = lad.as_ref() {
        let candidate = p.join("Google").join("Chrome").join("Application").join("chrome.exe");
        if candidate.exists() {
            return true;
        }
    }
    // 3. Registry (HKLM Chrome.exe path) — best-effort.
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(key) = hklm.open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") {
            let path: Option<String> = key.get_value("").ok();
            if let Some(p) = path {
                if PathBuf::from(p).exists() {
                    return true;
                }
            }
        }
    }
    false
}
```

Then, at the very top of `build_spawn_config` (before the node resolution), add the pre-check:

```rust
fn build_spawn_config(app: &AppHandle) -> Result<SpawnConfig, String> {
    if !chrome_installed() {
        eprintln!("[runner] Chrome not detected; daemon will fail to attach. " \
                   "Install Google Chrome from https://www.google.com/chrome/");
        return Err(
            "Google Chrome not found. Install it from https://www.google.com/chrome/ \
             — ma-browser controls your real Chrome via CDP."
                .into(),
        );
    }
    // ... (existing node resolution + port discovery continues here)
```

- [ ] **Step 4: Verify it compiles + lib tests still pass**

Run (from `packages/tray-app/src-tauri`):
```
cargo build --features tauri-app
cargo test --lib
```
Expected: build succeeds; lib tests still pass (unchanged pure logic).

- [ ] **Step 5: Commit**

```bash
git add packages/tray-app/src-tauri/src/daemon_runner.rs
git commit -m "feat(tray-app): prefer bundled node + Chrome pre-check before daemon spawn"
```

---

## Task 6: tauri.conf.json resources + version sync

Update `tauri.conf.json` so the portable build bundles `node/`, `daemon/`, `MicrosoftEdgeWebview2Setup.exe` as resources. (The version field is synced by the package script in Task 9; here we just ensure the resources glob is correct.)

**Files:**
- Modify: `packages/tray-app/src-tauri/tauri.conf.json`

- [ ] **Step 1: Expand the resources array**

Edit `packages/tray-app/src-tauri/tauri.conf.json`. Replace the `"resources"` array (currently `["icons/*.png"]`) with:

```json
    "resources": [
      "icons/*.png",
      "../icons/tray-green.png",
      "../icons/tray-red.png",
      "../icons/tray-yellow.png",
      "../../vendor/MicrosoftEdgeWebview2Setup.exe",
      "resources/node/**",
      "resources/daemon/**"
    ],
```

Note on the staging: the package script (Task 9) copies `node.exe` → `src-tauri/resources/node/node.exe` and the daemon bundle → `src-tauri/resources/daemon/` BEFORE `tauri build` runs, so these globs resolve. The `../icons/` paths reference the runtime tray-status icons that live at `packages/tray-app/icons/`. The bootstrapper is vendored at `packages/tray-app/vendor/`.

- [ ] **Step 2: Verify tauri config is valid JSON**

Run (from `packages/tray-app/src-tauri`):
```
cargo build --features tauri-app
```
Expected: succeeds (Tauri parses tauri.conf.json at build time; an invalid resources glob fails here).

- [ ] **Step 3: Commit**

```bash
git add packages/tray-app/src-tauri/tauri.conf.json
git commit -m "feat(tray-app): bundle node/daemon/webview2 as Tauri resources"
```

---

## Task 7: Redesign icons (SVG → PNG/ICO)

Author a geometric-abstract SVG (multi-agent orbits/arcs, blue-purple gradient), render to 1024×1024 PNG, run `pnpm tauri icon` to regenerate the full `src-tauri/icons/` set, and author 3 status-icon variants (green/yellow/red) at `packages/tray-app/icons/`.

**Files:**
- Create: `packages/tray-app/icons/source.svg`
- Create: `packages/tray-app/icons/tray-green.png`, `tray-red.png`, `tray-yellow.png`
- Modify: `packages/tray-app/src-tauri/icons/*` (regenerated by `tauri icon`)

- [ ] **Step 1: Author the master SVG**

Create `packages/tray-app/icons/source.svg` — a 1024×1024 geometric abstract mark. Three concentric orbital arcs (representing multiple agents) around a central node, blue→purple gradient:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4F46E5"/>
      <stop offset="1" stop-color="#9333EA"/>
    </linearGradient>
    <linearGradient id="arc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#A5B4FC"/>
      <stop offset="1" stop-color="#E9D5FF"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <!-- three orbital arcs (multi-agent) -->
  <g fill="none" stroke="url(#arc)" stroke-width="28" stroke-linecap="round">
    <path d="M 320 700 A 280 280 0 0 1 700 320"/>
    <path d="M 250 540 A 320 320 0 0 1 540 250" opacity="0.7"/>
    <path d="M 392 760 A 260 260 0 0 1 760 392" opacity="0.5"/>
  </g>
  <!-- central node (the shared browser) -->
  <circle cx="512" cy="512" r="72" fill="#FFFFFF"/>
  <circle cx="512" cy="512" r="36" fill="url(#bg)"/>
  <!-- agent dots on the orbits -->
  <g fill="#FFFFFF">
    <circle cx="700" cy="320" r="20"/>
    <circle cx="320" cy="700" r="20"/>
    <circle cx="760" cy="392" r="16"/>
    <circle cx="392" cy="760" r="16"/>
  </g>
</svg>
```

- [ ] **Step 2: Render SVG → 1024 PNG**

Use an SVG→PNG renderer. From `packages/tray-app/icons`:
```
npx --yes svgexport source.svg source.png 1024:1024
```
Expected: `source.png` (1024×1024) created. If `svgexport` is unavailable, use any tool that rasterizes SVG to PNG at 1024×1024 (e.g. `magick convert -density 384 source.svg -resize 1024x1024 source.png` if ImageMagick is installed). Verify the file exists and is non-trivial in size (>10KB).

- [ ] **Step 3: Regenerate the Tauri icon set**

From `packages/tray-app`:
```
pnpm tauri icon icons/source.png
```
Expected: `src-tauri/icons/` is regenerated with `icon.ico`, `icon.png`, and the `32x32.png`/`128x128.png`/etc. set. This overwrites the existing low-design icons.

- [ ] **Step 4: Author the 3 status-icon variants**

The status icons are small (tray uses ~16-32px). Create three variants derived from the master mark but simplified for tiny sizes. Create each as an SVG then render to PNG at 64×64 (Tauri/OS scales down):

`packages/tray-app/icons/tray-green.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="26" fill="#22C55E"/>
  <circle cx="32" cy="32" r="10" fill="#FFFFFF"/>
  <circle cx="48" cy="20" r="5" fill="#FFFFFF"/>
  <circle cx="16" cy="44" r="5" fill="#FFFFFF"/>
</svg>
```

`packages/tray-app/icons/tray-yellow.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="24" fill="none" stroke="#EAB308" stroke-width="5"/>
  <circle cx="32" cy="32" r="10" fill="#EAB308" opacity="0.5"/>
  <circle cx="48" cy="20" r="4" fill="#EAB308"/>
  <circle cx="16" cy="44" r="4" fill="#EAB308"/>
</svg>
```

`packages/tray-app/icons/tray-red.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="24" fill="none" stroke="#EF4444" stroke-width="5"/>
  <circle cx="32" cy="32" r="6" fill="#EF4444"/>
  <circle cx="48" cy="20" r="4" fill="none" stroke="#EF4444" stroke-width="3"/>
  <circle cx="16" cy="44" r="4" fill="none" stroke="#EF4444" stroke-width="3"/>
</svg>
```

Render each:
```
npx --yes svgexport tray-green.svg tray-green.png 64:64
npx --yes svgexport tray-yellow.svg tray-yellow.png 64:64
npx --yes svgexport tray-red.svg tray-red.png 64:64
```

- [ ] **Step 5: Verify icons exist**

Check that `packages/tray-app/icons/tray-green.png`, `tray-red.png`, `tray-yellow.png` and `packages/tray-app/src-tauri/icons/icon.ico` all exist.

- [ ] **Step 6: Commit**

```bash
git add packages/tray-app/icons/ packages/tray-app/src-tauri/icons/
git commit -m "feat(tray-app): redesign app + status icons (geometric abstract multi-agent)"
```

---

## Task 8: Wire auto-update + WebView2 check into app.rs (menu + startup)

Modify `app.rs` to: (a) call `webview2_check::ensure_installed` at startup, (b) spawn the update check on startup, (c) add `check_update` + `update_available` menu items, (d) store `update_info` in `controller`, (e) fix the About dialog version + repo link.

**Files:**
- Modify: `packages/tray-app/src-tauri/src/app.rs`
- Modify: `packages/tray-app/src-tauri/src/controller.rs` (hold `update_info`)

- [ ] **Step 1: Add update_info to TrayController**

Edit `packages/tray-app/src-tauri/src/controller.rs`. Add a field to `TrayController`:

```rust
pub struct TrayController {
    supervisor: Supervisor,
    cdp_state: CdpState,
    daemon_port: Option<u16>,
    cdp_port: Option<u16>,
    token: Option<String>,
    update_info: Option<crate::update_checker::UpdateInfo>,
}
```

Update `new()` to initialize `update_info: None`. Add accessor methods near the other setters:

```rust
    /// Store the latest release info (called when the update check finds one).
    pub fn set_update_info(&mut self, info: Option<crate::update_checker::UpdateInfo>) {
        self.update_info = info;
    }

    /// Current update info, if a newer release was detected.
    pub fn update_info(&self) -> Option<&crate::update_checker::UpdateInfo> {
        self.update_info.as_ref()
    }
```

- [ ] **Step 2: Add menu IDs in app.rs**

Edit `packages/tray-app/src-tauri/src/app.rs`. Add two IDs to the constants block (after `ID_QUIT`):

```rust
const ID_CHECK_UPDATE: &str = "check_update";
const ID_UPDATE_AVAILABLE: &str = "update_available";
```

- [ ] **Step 3: Build the new menu items**

In `build_menu`, add the new items before the About item. Insert after the `sep4` definition and before `let about = ...`:

```rust
    let check_update =
        MenuItem::with_id(app, ID_CHECK_UPDATE, "检查更新", true, None::<&str>)?;
    // update_available is built dynamically after an update is detected; here
    // we create it hidden (disabled) and refresh_tray enables+labels it.
    let update_available =
        MenuItem::with_id(app, ID_UPDATE_AVAILABLE, "", false, None::<&str>)?;
```

Then add `&check_update` and `&update_available` to the `Menu::with_items` array, positioned right before `&about`:

```rust
    let menu = Menu::with_items(
        app,
        &[
            &status_row,
            &sep1,
            &toggle_daemon,
            &restart,
            &sep2,
            &open_logs,
            &diagnostics,
            &sep3,
            &settings_submenu,
            &sep4,
            &check_update,
            &update_available,
            &about,
            &quit,
        ],
    )?;
```

Add `update_available` to `MenuHandles` (so `refresh_tray` can re-label/enable it):

```rust
pub struct MenuHandles {
    pub status_row: MenuItem<tauri::Wry>,
    pub toggle_daemon: MenuItem<tauri::Wry>,
    pub restart: MenuItem<tauri::Wry>,
    pub update_available: MenuItem<tauri::Wry>,
}
```

And set it in the `MenuHandles { ... }` construction in `build_menu`:
```rust
    let handles = MenuHandles {
        status_row,
        toggle_daemon,
        restart,
        update_available,
    };
```

- [ ] **Step 4: Handle the menu events**

In `handle_menu_event`, add cases before the `_ => {}`:

```rust
        ID_CHECK_UPDATE => {
            let app_clone = app.clone();
            tauri::async_runtime::spawn(async move {
                match crate::update_checker::check_latest(crate::update_checker::RELEASE_REPO).await {
                    Some(info) => {
                        let is_new = crate::update_checker::is_update_available(&info.latest_version);
                        let app_clone2 = app_clone.clone();
                        let _ = app_clone.run_on_main_thread(move || {
                            {
                                let state = app_clone2.state::<AppState>();
                                let mut c = state.controller.lock().unwrap();
                                c.set_update_info(if is_new { Some(info.clone()) } else { None });
                            }
                            refresh_tray(&app_clone2);
                        });
                    }
                    None => {
                        // Rate-limited / network failure — show "稍后再试".
                        let _ = app_clone.run_on_main_thread(move || {
                            let state = app_clone.state::<AppState>();
                            if let Some(h) = state.menu_handles.lock().unwrap().as_ref() {
                                let _ = h.update_available.set_text("检查失败,稍后再试");
                                let _ = h.update_available.set_enabled(true);
                            }
                        });
                    }
                }
            });
            return;
        }
        ID_UPDATE_AVAILABLE => {
            let url = {
                let state = app.state::<AppState>();
                let c = state.controller.lock().unwrap();
                c.update_info().map(|i| i.release_url.clone())
            };
            if let Some(url) = url {
                let _ = app.opener().open_url(url, None::<&str>);
            }
            return;
        }
```

- [ ] **Step 5: Refresh update_available label in refresh_tray**

In `refresh_tray`, after the existing menu-handle updates (the `if let Some(handles) = guard.as_ref()` block), add update-info rendering before `drop(guard)`:

```rust
        // Update the "new version available" item.
        let update_label = {
            let state = app.state::<AppState>();
            let c = state.controller.lock().unwrap();
            c.update_info()
                .map(|i| format!("🆕 有新版本 v{}", i.latest_version))
        };
        if let Some(label) = update_label {
            let _ = handles.update_available.set_text(&label);
            let _ = handles.update_available.set_enabled(true);
        } else {
            let _ = handles.update_available.set_text("");
            let _ = handles.update_available.set_enabled(false);
        }
```

- [ ] **Step 6: Spawn startup update check + WebView2 check in setup**

In `run()`, inside `.setup(|app| { ... })`, add the WebView2 check first and the update check after the existing `dispatch_event(app.handle(), Event::UserStart)`:

```rust
        .setup(|app| {
            // Pre-start: if WebView2 is missing, prompt + launch bootstrapper
            // and exit so the installer can run.
            if crate::webview2_check::ensure_installed(app.handle()) {
                app.exit(0);
                return Ok(());
            }
            setup_tray(app.handle())?;
            apply_popup_effects(app.handle());
            dispatch_event(app.handle(), Event::UserStart);

            // Background update check — silent on any failure.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(info) =
                    crate::update_checker::check_latest(crate::update_checker::RELEASE_REPO).await
                {
                    if crate::update_checker::is_update_available(&info.latest_version) {
                        let app_clone = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            {
                                let state = app_clone.state::<AppState>();
                                let mut c = state.controller.lock().unwrap();
                                c.set_update_info(Some(info));
                            }
                            refresh_tray(&app_clone);
                        });
                    }
                }
            });
            Ok(())
        })
```

- [ ] **Step 7: Fix About dialog version + repo link**

In `handle_menu_event`, the `ID_ABOUT` case currently has a hardcoded `"版本: 0.0.1\n\n"` and a wrong `github.com/anthropics/ma-browser` link. Replace the `concat!(...)`:

```rust
        ID_ABOUT => {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            let version = crate::update_checker::current_version();
            app.dialog()
                .message(format!(
                    "版本: {}\n\n\
                     ma-browser 让 AI 通过 Chrome DevTools Protocol\n\
                     直接控制你真实的 Chrome 浏览器。\n\n\
                     GitHub: github.com/zzhan111/multi-agents-browser",
                    version
                ))
                .title("关于 ma-browser")
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
```

- [ ] **Step 8: Verify it compiles**

Run (from `packages/tray-app/src-tauri`):
```
cargo build --features tauri-app
```
Expected: succeeds. Fix any borrow/move errors in the async closures (the pattern of cloning `app_handle`/`app_clone` mirrors `daemon_runner.rs`).

- [ ] **Step 9: Commit**

```bash
git add packages/tray-app/src-tauri/src/app.rs packages/tray-app/src-tauri/src/controller.rs
git commit -m "feat(tray-app): wire auto-update detection + WebView2 check into tray"
```

---

## Task 9: package-win.mjs build script

Create the portable-zip build script. It runs Phase 0 (version sync) → Phase 1 (pnpm build + tauri build) → Phase 2 (assemble staging) → Phase 3 (fetch node.exe) → Phase 4 (zip + verify).

**Files:**
- Create: `packages/tray-app/scripts/package-win.mjs`
- Modify: `packages/tray-app/package.json` (add `package:win` script)
- Modify: `packages/tray-app/.gitignore` (add `.cache/`, `dist/`)

- [ ] **Step 1: Add .gitignore entries + package:win script**

Create or edit `packages/tray-app/.gitignore` (append):
```
.cache/
dist/
src-tauri/resources/
```

(`src-tauri/resources/` is where the script stages node/daemon before `tauri build`; it must not be committed.)

Edit `packages/tray-app/package.json`, add to `scripts`:
```json
    "package:win": "node scripts/package-win.mjs"
```

- [ ] **Step 2: Write package-win.mjs**

Create `packages/tray-app/scripts/package-win.mjs`:

```javascript
// Portable Windows zip builder for ma-browser-tray.
// Run: pnpm package:win  (from packages/tray-app)
// Produces: dist/ma-browser-tray-portable-v{VERSION}.zip
//
// Phases:
//   0. Version sync (package.json -> Cargo.toml + tauri.conf.json)
//   1. pnpm build (daemon bundle) + tauri build (exe with embedded resources)
//   2. Assemble staging dir (exe + daemon + icons + readme)
//   3. Fetch node.exe (download official Node LTS, extract node.exe only)
//   4. zip + structure verify

import { execSync, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAY_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(TRAY_DIR, '..', '..');
const NODE_VERSION = 'v20.15.0'; // pinned LTS; bump here to upgrade bundled Node

// --- helpers ----------------------------------------------------------------

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}${cwd ? '  (in ' + cwd + ')' : ''}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    throw new Error(`${cmd} exited with ${r.status}`);
  }
}

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function patchFileRegex(path, regex, replacement) {
  const txt = readFileSync(path, 'utf8');
  if (!regex.test(txt)) throw new Error(`patchFile: pattern not found in ${path}`);
  writeFileSync(path, txt.replace(regex, replacement));
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// --- Phase 0: version sync --------------------------------------------------

function syncVersion() {
  console.log('\n=== Phase 0: version sync ===');
  const { version } = readJson(join(REPO_ROOT, 'package.json'));
  console.log(`package.json version = ${version}`);
  patchFileRegex(join(TRAY_DIR, 'src-tauri', 'Cargo.toml'), /^version = ".*"/m, `version = "${version}"`);
  const confPath = join(TRAY_DIR, 'src-tauri', 'tauri.conf.json');
  const conf = readJson(confPath);
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  console.log('Synced Cargo.toml + tauri.conf.json');
}

// --- Phase 1: build ---------------------------------------------------------

function build() {
  console.log('\n=== Phase 1: build (pnpm build + tauri build) ===');
  run('pnpm', ['build'], REPO_ROOT); // turbo build -> daemon tsup bundle
  // Stage resources into src-tauri/resources/ so tauri.conf.json globs resolve.
  const resDir = join(TRAY_DIR, 'src-tauri', 'resources');
  rmSync(resDir, { recursive: true, force: true });
  mkdirSync(join(resDir, 'node'), { recursive: true });
  mkdirSync(join(resDir, 'daemon'), { recursive: true });
  copyFileSync(
    join(TRAY_DIR, 'vendor', 'MicrosoftEdgeWebview2Setup.exe'),
    join(resDir, 'MicrosoftEdgeWebview2Setup.exe')
  );
  // daemon bundle + runtime deps
  copyFileSync(
    join(REPO_ROOT, 'packages', 'daemon', 'dist', 'index.js'),
    join(resDir, 'daemon', 'index.js')
  );
  copyFileSync(
    join(REPO_ROOT, 'packages', 'daemon', 'src', 'buildDomTree.js'),
    join(resDir, 'daemon', 'buildDomTree.js')
  );
  copyDir(
    join(REPO_ROOT, 'packages', 'daemon', 'node_modules', 'ws'),
    join(resDir, 'daemon', 'node_modules', 'ws')
  );
  // node.exe placeholder file so the glob resolves during tauri build;
  // real node.exe is fetched in Phase 3 and copied into staging (and the exe
  // resource). For the embedded-resource build we also need it present here:
  ensureNodeExe(join(resDir, 'node', 'node.exe'));

  run('pnpm', ['tauri', 'build'], TRAY_DIR);
}

// --- Phase 2: assemble staging ----------------------------------------------

function assembleStaging(staging) {
  console.log('\n=== Phase 2: assemble staging ===');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const exe = join(TRAY_DIR, 'src-tauri', 'target', 'release', 'ma-browser-tray.exe');
  if (!existsSync(exe)) throw new Error(`exe not found: ${exe}`);
  copyFileSync(exe, join(staging, 'ma-browser-tray.exe'));
  copyFileSync(
    join(TRAY_DIR, 'vendor', 'MicrosoftEdgeWebview2Setup.exe'),
    join(staging, 'MicrosoftEdgeWebview2Setup.exe')
  );
  mkdirSync(join(staging, 'daemon', 'node_modules'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'packages', 'daemon', 'dist', 'index.js'), join(staging, 'daemon', 'index.js'));
  copyFileSync(join(REPO_ROOT, 'packages', 'daemon', 'src', 'buildDomTree.js'), join(staging, 'daemon', 'buildDomTree.js'));
  copyDir(join(REPO_ROOT, 'packages', 'daemon', 'node_modules', 'ws'), join(staging, 'daemon', 'node_modules', 'ws'));
  mkdirSync(join(staging, 'node'), { recursive: true });
  ensureNodeExe(join(staging, 'node', 'node.exe'));
  copyDir(join(TRAY_DIR, 'icons'), join(staging, 'icons'));
  copyFileSync(join(TRAY_DIR, 'README.txt'), join(staging, 'README.txt'));
  copyFileSync(join(TRAY_DIR, 'README-EN.txt'), join(staging, 'README-EN.txt'));
  console.log('Staging assembled at', staging);
}

// --- Phase 3: fetch node.exe ------------------------------------------------

async function ensureNodeExe(dest) {
  if (existsSync(dest) && statSync(dest).size > 10_000_000) return; // already have it
  const cacheDir = join(TRAY_DIR, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const cacheZip = join(cacheDir, `node-${NODE_VERSION}-win-x64.zip`);
  if (!existsSync(cacheZip)) {
    const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
    console.log(`Downloading ${url} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cacheZip, buf);
  }
  // Extract only node.exe from the zip. Use the system 'tar' (Win10+ ships it).
  mkdirSync(dirname(dest), { recursive: true });
  const member = `node-${NODE_VERSION}-win-x64/node.exe`;
  const r = spawnSync('tar', ['-xf', cacheZip, '-C', dirname(dest), member], { shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`tar extract failed: ${r.status}`);
  // tar extracts to <destDir>/node-.../node.exe; move it up.
  const extracted = join(dirname(dest), member);
  copyFileSync(extracted, dest);
  rmSync(join(dirname(dest), `node-${NODE_VERSION}-win-x64`), { recursive: true, force: true });
  console.log('node.exe ready at', dest);
}

// --- Phase 4: zip + verify --------------------------------------------------

function zipAndVerify(staging, version) {
  console.log('\n=== Phase 4: zip + verify ===');
  const distDir = join(TRAY_DIR, 'dist');
  mkdirSync(distDir, { recursive: true });
  const zipName = `ma-browser-tray-portable-v${version}.zip`;
  const zipPath = join(distDir, zipName);
  if (existsSync(zipPath)) rmSync(zipPath);
  // Use PowerShell Compress-Archive on Windows; tar fallback otherwise.
  if (process.platform === 'win32') {
    const ps = `Compress-Archive -Path '${staging}' -DestinationPath '${zipPath}' -Force`;
    spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit', shell: true });
  } else {
    run('tar', ['-a', '-c', '-f', zipPath, '-C', dirname(staging), 'ma-browser-tray']);
  }
  // Verify structure (extract to temp and assert required files).
  verifyStructure(staging);
  console.log(`\n✓ Built ${zipPath}`);
}

function verifyStructure(staging) {
  const required = [
    'ma-browser-tray.exe',
    'MicrosoftEdgeWebview2Setup.exe',
    'node/node.exe',
    'daemon/index.js',
    'daemon/buildDomTree.js',
    'daemon/node_modules/ws/index.js',
    'icons/tray-green.png',
    'icons/tray-red.png',
    'icons/tray-yellow.png',
    'README.txt',
    'README-EN.txt',
  ];
  const missing = required.filter((r) => !existsSync(join(staging, r)));
  if (missing.length) {
    throw new Error(`verifyStructure: missing files: ${missing.join(', ')}`);
  }
  console.log('Structure verified: all required files present.');
}

// --- main -------------------------------------------------------------------

async function main() {
  // Pre-check: vendored bootstrapper must exist.
  const bootstrapper = join(TRAY_DIR, 'vendor', 'MicrosoftEdgeWebview2Setup.exe');
  if (!existsSync(bootstrapper)) {
    throw new Error(
      `Missing ${bootstrapper}. Download the WebView2 Evergreen Bootstrapper from ` +
      `https://developer.microsoft.com/microsoft-edge/webview2/ and place it there.`
    );
  }
  syncVersion();
  build();
  const { version } = readJson(join(REPO_ROOT, 'package.json'));
  const staging = join(TRAY_DIR, 'dist', 'portable-staging', 'ma-browser-tray');
  assembleStaging(staging);
  zipAndVerify(staging, version);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Verify the script parses (syntax check)**

Run (from `packages/tray-app`):
```
node --check scripts/package-win.mjs
```
Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add packages/tray-app/scripts/package-win.mjs packages/tray-app/package.json packages/tray-app/.gitignore
git commit -m "feat(tray-app): portable-zip build script (pnpm package:win)"
```

---

## Task 10: End-user README (Chinese + English)

Create `README.txt` (Chinese) and `README-EN.txt` (English) per spec §6.1.

**Files:**
- Create: `packages/tray-app/README.txt`
- Create: `packages/tray-app/README-EN.txt`

- [ ] **Step 1: Write README.txt (Chinese)**

Create `packages/tray-app/README.txt`:

```
ma-browser 浏览器代理 — 快速开始
================================

1. 解压本 zip 到任意目录(无需安装,无需管理员)

2. 双击 ma-browser-tray.exe
   - 首次运行如提示缺少 WebView2,点"确定"自动安装,装完重新双击 exe
   - 托盘图标变绿 = 一切就绪

3. 需要 Google Chrome 浏览器(用于复用你的登录态)
   - 没装? 下载: https://www.google.com/chrome/

4. 配置你的 AI 客户端(Claude Code / Cursor / Cline):
   - 打开托盘 → 右键 → 复制 MCP 配置
   - 粘贴到你的客户端配置文件

5. 日志与状态:
   - 托盘右键 → 打开日志
   - 状态目录: %USERPROFILE%\.bb-browser\

6. 更新:
   - 有新版本时,右键托盘菜单会显示 "🆕 有新版本 vX.Y.Z"
   - 点击该项打开下载页,下载新 zip
   - 退出当前程序(右键→退出),解压新 zip 替换整个目录,重新双击 exe

卸载: 删除整个解压目录即可(不写注册表)

注: 首次运行 Windows SmartScreen 可能提示"已保护你的电脑",
点"更多信息"→"仍要运行"即可(本程序未购买代码签名证书)。
```

- [ ] **Step 2: Write README-EN.txt (English)**

Create `packages/tray-app/README-EN.txt`:

```
ma-browser Browser Agent — Quick Start
======================================

1. Extract this zip to any folder (no installer, no admin required)

2. Double-click ma-browser-tray.exe
   - On first run, if prompted about a missing WebView2, click OK to
     auto-install it, then double-click the exe again
   - Tray icon turns green = ready

3. Google Chrome is required (to reuse your login state)
   - Not installed? Download: https://www.google.com/chrome/

4. Configure your AI client (Claude Code / Cursor / Cline):
   - Open the tray → right-click → Copy MCP config
   - Paste into your client's config file

5. Logs & state:
   - Tray right-click → Open logs
   - State dir: %USERPROFILE%\.bb-browser\

6. Updates:
   - When a new version is available, the right-click tray menu shows
     "🆕 有新版本 vX.Y.Z"
   - Click it to open the download page and download the new zip
   - Exit the app (right-click → Exit), extract the new zip to replace the
     whole folder, then double-click the exe again

Uninstall: just delete the extracted folder (no registry entries)

Note: On first run Windows SmartScreen may warn "Windows protected your PC";
click "More info" → "Run anyway" (this app is not code-signed).
```

- [ ] **Step 3: Commit**

```bash
git add packages/tray-app/README.txt packages/tray-app/README-EN.txt
git commit -m "docs(tray-app): add Chinese + English end-user quick-start README"
```

---

## Task 11: Developer docs (packaging + smoke-test)

Create `docs/tray-app-packaging.md` and `docs/tray-app-smoke-test.md` per spec §6.2/§6.3 and §8.7.

**Files:**
- Create: `docs/tray-app-packaging.md`
- Create: `docs/tray-app-smoke-test.md`

- [ ] **Step 1: Write packaging guide**

Create `docs/tray-app-packaging.md`:

```markdown
# Tray-App Packaging Guide

How to build the portable Windows zip from source.

## Prerequisites (build machine)

- Rust toolchain (rustup) — for `cargo` / Tauri build
- Tauri CLI — `pnpm tauri` (installed via the repo's pnpm workspace)
- Node.js 20+ and pnpm 9+
- Windows 10+ (the build produces a Windows exe; cross-building is not supported)

## One-time setup

1. Download the WebView2 Evergreen Bootstrapper from
   https://developer.microsoft.com/microsoft-edge/webview2/
   (the small "Evergreen Bootstrapper" `.exe`, ~2MB).
2. Place it at `packages/tray-app/vendor/MicrosoftEdgeWebview2Setup.exe`.

   This file is git-tracked. It is the only manual step.

## Build

```bash
cd packages/tray-app
pnpm package:win
```

Produces: `packages/tray-app/dist/ma-browser-tray-portable-v{VERSION}.zip`

The script:
- Phase 0: syncs `package.json` version → `Cargo.toml` + `tauri.conf.json`
- Phase 1: `pnpm build` (daemon bundle) + `tauri build` (exe with embedded resources)
- Phase 2: assembles a staging dir (exe + daemon + node + icons + README)
- Phase 3: downloads the pinned Node.js LTS, extracts `node.exe` (cached in `.cache/`)
- Phase 4: zips the staging dir + verifies all required files are present

## Artifact structure

```
ma-browser-tray/
├── ma-browser-tray.exe
├── MicrosoftEdgeWebview2Setup.exe
├── node/node.exe
├── daemon/{index.js, buildDomTree.js, node_modules/ws/}
├── icons/{tray-green,red,yellow}.png
├── README.txt
└── README-EN.txt
```

## Upgrade the bundled Node

Edit `NODE_VERSION` at the top of `packages/tray-app/scripts/package-win.mjs`,
delete `packages/tray-app/.cache/`, and rerun `pnpm package:win`.

## Release a new version

1. Bump `version` in the repo-root `package.json`
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. `pnpm package:win` → produces the zip
4. Create a Release on GitHub (zzhan111/multi-agents-browser), tag = `vX.Y.Z`
5. Upload the zip to the Release assets
6. Users' trays detect the new version on next startup (GitHub Releases API)

## Verify

See `docs/tray-app-smoke-test.md`.
```

- [ ] **Step 2: Write smoke-test guide**

Create `docs/tray-app-smoke-test.md`:

```markdown
# Tray-App Smoke Test Checklist

Pre-release verification on a clean Windows 10 environment.

## Environment

- Windows 10 1903+ fresh VM
- **No Node.js installed** (proves the bundled node works)
- **No WebView2 Runtime** (proves the bootstrapper path)
- Google Chrome installed (the one dependency that is NOT bundled, by design)

## Steps

1. Extract the zip to `C:\ma-browser-tray` (a path with no spaces first; then
   repeat with a space-containing path like `C:\My Apps\ma-browser-tray` to
   verify the bundled-node space-in-path fix).
2. Double-click `ma-browser-tray.exe`.
3. **[Expected]** If WebView2 is missing, a popup appears → click OK → the
   bootstrapper installs WebView2 → the app exits. Double-click the exe again.
4. **[Expected]** A tray icon appears and turns **green within 10 seconds**
   (bundled node starts the daemon, daemon attaches to Chrome).
5. Right-click the tray → click "Copy MCP config" (or the equivalent menu
   item) → the clipboard contains a daemon URL + token.
6. Configure Claude Code with that MCP config; run one `browser snapshot`.
7. **[Expected]** The snapshot returns page info; the tray shows activity.
8. **[Expected]** The tray menu shows "检查更新"; clicking it does not error
   (when network is available).
9. **[Expected]** Right-click → About shows a version equal to `package.json`'s
   version (NOT `0.0.1`).

## Pass criteria

Steps 4, 6, and 9 green = pass. The space-in-path variant (step 1) must also
pass for the bundled-node fix to be considered validated.

## Failure triage

| Symptom | Investigate |
|---------|-------------|
| Step 3: no popup, exe silently dies | `webview2_check.rs` registry detection; bootstrapper path |
| Step 4: icon stays red | `daemon_runner.rs` bundled-node resolution; check `%USERPROFILE%\.bb-browser\` logs |
| Step 4: icon yellow forever | daemon started but Chrome not found; `chrome_installed()` pre-check |
| Step 6: snapshot fails | CDP connectivity; token in daemon.json |
| Step 9: shows `0.0.1` | `build.rs` `BB_BROWSER_VERSION` injection; `package-win.mjs` Phase 0 |
```

- [ ] **Step 3: Commit**

```bash
git add docs/tray-app-packaging.md docs/tray-app-smoke-test.md
git commit -m "docs: add tray-app packaging guide + smoke-test checklist"
```

---

## Task 12: Full build verification

Run the complete `pnpm package:win` end-to-end and confirm the zip is produced and structurally valid. This is the integration gate before the manual clean-environment smoke test.

**Files:** none (verification only)

- [ ] **Step 1: Confirm the vendored bootstrapper is present**

Check `packages/tray-app/vendor/MicrosoftEdgeWebview2Setup.exe` exists. If not, pause and obtain it per `docs/tray-app-packaging.md` "One-time setup".

- [ ] **Step 2: Run the full package script**

From `packages/tray-app`:
```
set NODE_ENV=development
pnpm package:win
```
Expected: completes all 5 phases; last line is `✓ Built ...ma-browser-tray-portable-v{VERSION}.zip`. The structure-verify step prints "Structure verified: all required files present."

If `tauri build` fails on the resources globs, confirm `packages/tray-app/src-tauri/resources/{node,daemon}/` were staged by the script and that `tauri.conf.json` `resources` matches Task 6.

- [ ] **Step 3: Inspect the produced zip**

Open the zip (or extract to a temp dir) and confirm the layout matches spec §3.2: `ma-browser-tray.exe`, `MicrosoftEdgeWebview2Setup.exe`, `node/node.exe` (>30MB), `daemon/index.js`, `daemon/buildDomTree.js`, `daemon/node_modules/ws/`, `icons/tray-{green,red,yellow}.png`, `README.txt`, `README-EN.txt`.

- [ ] **Step 4: Run lib unit tests one more time**

From `packages/tray-app/src-tauri`:
```
cargo test --lib
```
Expected: all pass (including the 11 new `version` tests from Task 1).

- [ ] **Step 5: Commit any build-script fixes discovered during the run**

If the run surfaced bugs in `package-win.mjs` (e.g. a path issue), fix and commit:
```bash
git add packages/tray-app/scripts/package-win.mjs
git commit -m "fix(tray-app): package-win.mjs path fixes from dry-run"
```

(If no fixes were needed, skip this step.)

- [ ] **Step 6: Final commit — mark plan complete**

If the working tree is clean after the above, no commit needed. Otherwise commit any remaining changes with:
```bash
git add -A
git commit -m "chore(tray-app): portable deployment build verified"
```

The portable zip is now built. The remaining verification (clean-environment smoke test per `docs/tray-app-smoke-test.md`) is a manual, pre-release step — not part of this implementation plan.
