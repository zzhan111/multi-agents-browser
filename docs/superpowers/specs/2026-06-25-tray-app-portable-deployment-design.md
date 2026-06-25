# Tray-App Portable Deployment Design

> **Date:** 2026-06-25
> **Status:** Design — pending implementation plan
> **Branch:** `feat/tray-app-deploy`
> **Goal:** Produce a self-contained portable zip that an end user can extract and run on a clean Windows 10+ machine with zero Node.js install, zero admin, and zero networking (except a one-time WebView2 bootstrap).

---

## 1. Background & Problem

`ma-browser-tray.exe` is a Tauri v2 (Rust) supervisor that spawns a **Node.js child process** running `daemon/index.js`. The daemon connects to the user's real Chrome via CDP (reusing login state — a core product value).

Current state (verified in `packages/tray-app/src-tauri/`):

- `daemon_runner.rs::build_spawn_config` locates `node` via `which::which("node")` — **Node.js must be pre-installed on PATH**. Hard blocker for "zero-dependency" deployment.
- `locate_daemon_entry` expects `resource_dir/daemon/index.js` in a packaged install, but `tauri.conf.json` `resources` only globs `icons/*.png` — **daemon is not bundled**.
- The daemon needs `node_modules/ws` (runtime dep that tsup cannot inline) plus `buildDomTree.js` (dynamic script).
- WebView2 Runtime (Tauri hard dependency): pre-installed on Win11, **may be absent on Win10**.
- Chrome: must be the user's own (cannot be bundled without destroying the login-state value).
- A manually-assembled install exists at `Z:\Apps\bb-browser-tray` (exe + daemon/ + node_modules/ws + icons + WebView2Loader.dll), proving the layout works — but it has **no automated build script** and still relies on system Node.
- No icon redesign: current icons are functional but low-design.

**Gap to "end user runs perfectly":** Node not bundled, daemon not in Tauri resources, WebView2 may be missing, Chrome presence unverified, no reproducible build script, no install docs, no icon polish.

## 2. Confirmed Decisions

| Decision | Choice |
|----------|--------|
| Node runtime | **Bundle node.exe** inside the zip |
| Install format | **Portable zip** (no installer, no registry) |
| Auto-start on boot | **Not in MVP** (hide the menu item) |
| WebView2 | **Bundle Bootstrapper**, guide install if missing |
| Chrome | **Not bundled** — detect + guide |
| Build flow | **pnpm script** (`pnpm package:win`) |
| Verification | **Clean-environment smoke test** |
| Node bundling approach | **Tauri resources** (resource_dir-based, consistent with existing daemon location logic) |
| Icon direction | **Geometric abstract / multi-agent** (SVG → PNG → tauri icon toolchain) |
| Auto-update granularity | **Detect only + guide manual replacement** (portable exe cannot self-swap) |
| Auto-update channel | **GitHub Releases API** (`zzhan111/multi-agents-browser`) |
| Auto-update version source | **Unified to `package.json`** (eliminates hardcoded `0.0.1`) |
| Auto-update timing | **Startup (background) + manual menu item** |
| Auto-update notification | **Menu text label only** |
| MCP entry layout | **Dedicated `mcp/` subdirectory** (sibling to `daemon/`) |
| MCP ↔ daemon relation | **Connect-only** (`MA_BROWSER_CONNECT_ONLY=1`); tray owns the daemon |
| MCP config delivery | **Dual-track**: machine-readable `mcp-config.json` in zip root (agent self-configures) + tray "Copy MCP config" menu (human manual fallback) |
| Agent discovery | **`mcp-config.json` + README instruction** (agent reads the file at the extracted dir) |

## 3. Product — Target & Artifact Layout

### 3.1 Target

One portable zip. End user on Win10+ clean machine: extract → double-click `ma-browser-tray.exe` → built-in Node daemon starts → connects to user's Chrome → tray icon turns green → a coding agent can then read `mcp-config.json` from the extracted dir and self-configure its MCP client to drive the browser. No pre-installed Node, no admin, no networking except first-run WebView2 bootstrap.

### 3.2 Zip Layout

```
ma-browser-tray-portable-v{VERSION}.zip
└── ma-browser-tray/                      # single root dir after extraction
    ├── ma-browser-tray.exe               # Tauri build (embeds WebView2Loader.dll)
    ├── MicrosoftEdgeWebview2Setup.exe     # WebView2 Evergreen Bootstrapper (~2MB)
    ├── node/
    │   └── node.exe                      # bundled Node.js v20.x win-x64 (~40MB)
    ├── daemon/
    │   ├── index.js                      # tsup bundle (inlines compile-time deps)
    │   ├── buildDomTree.js               # runtime-required dynamic script
    │   └── node_modules/
    │       └── ws/                       # only runtime dep that can't be inlined
    ├── mcp/
    │   └── mcp.js                        # MCP server bundle (tsup); runs connect-only
    ├── mcp-config.json                   # machine-readable MCP config (agent self-configures)
    ├── icons/
    │   ├── tray-green.png
    │   ├── tray-red.png
    │   └── tray-yellow.png
    ├── README.txt                        # Chinese quick-start
    └── README-EN.txt                     # English quick-start
```

**Estimated size:** ~56MB (node.exe 40 + daemon bundle 1 + mcp bundle 1 + ws 0.5 + webview2 bootstrapper 2 + exe 10 + icons). Acceptable.

**Key:** `node/`, `daemon/`, `mcp/`, `mcp-config.json`, `MicrosoftEdgeWebview2Setup.exe` are all Tauri resources, located at runtime via `resource_dir()` — consistent with `daemon_runner.rs` existing `locate_daemon_entry` logic.

## 4. Code Changes

### 4.1 Bundled Node Location — `daemon_runner.rs`

`build_spawn_config` currently uses `which::which("node")`. Change to **prefer bundled node**:

```rust
fn build_spawn_config(app: &AppHandle) -> Result<SpawnConfig, String> {
    // 1. Prefer bundled node (resource_dir/node/node.exe)
    let node_path = bundled_node_path(app)
        .or_else(|| which::which("node").ok())   // 2. fallback to system PATH
        .ok_or("no bundled node and node not on PATH")?;
    // ... rest unchanged: locate_daemon_entry (already resource_dir-first),
    //     port discovery, home_env
    Ok(SpawnConfig { program: node_path, args: vec![..], .. })
}

/// Locate the bundled node.exe under the Tauri resource dir.
fn bundled_node_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let candidate = dir.join("node").join("node.exe");
    candidate.exists().then_some(candidate)
}
```

**Space-in-path caveat:** `daemon_runner.rs:264-269` existing comment explains why it uses the bare name `node` rather than an absolute path (Windows `Command` resolution spuriously fails for absolute node paths containing spaces, e.g. `C:\Program Files\nodejs\node.exe`). The bundled path may contain spaces (e.g. `C:\Users\My Name\AppData\...`). Keep the bare-name fallback unchanged. When using the bundled absolute path, `Command::new(pathbuf)` with an absolute path is reliable — the prior failure was specific to `which`-resolved paths in certain configs. **Must verify in smoke test under a path containing spaces.**

### 4.2 WebView2 Missing-Install Guide — new `webview2_check.rs`

Tauri fails ungracefully (white screen / crash) when WebView2 is absent. Add a **pre-start check**:

```rust
fn ensure_webview2(app: &AppHandle) {
    if webview2_is_installed() { return; }
    // Missing: native MessageBox + guide to run the sibling bootstrapper
    let bootstrapper = app.path().resource_dir()
        .unwrap().join("MicrosoftEdgeWebview2Setup.exe");
    // Windows API MessageBox: "WebView2 Runtime required, click OK to install"
    // User confirms -> Command::new(bootstrapper).spawn() -> prompt to restart app
}
```

`webview2_is_installed()` reads registry `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}` (official WebView2 detection).

### 4.3 Chrome Missing-Install Guide — `daemon_runner.rs`

Daemon spawn failure currently routes to `on_early_exit` → tray red. **Improve:** pre-check Chrome existence before spawn; on absence show a clear Toast/dialog + download link instead of a vague "daemon exited".

```rust
fn chrome_installed() -> bool {
    // Check common paths: Program Files\Google\Chrome\...\chrome.exe
    // + LOCALAPPDATA\Google\Chrome
    // + registry HKLM\...\Chrome
}
```

### 4.4 Icon Redesign — SVG source + toolchain

**App icon** (`src-tauri/icons/`): author a 1024×1024 SVG (geometric abstract: multiple agent orbits/arcs interwoven, blue-purple gradient), convert to PNG, run `pnpm tauri icon <png>` to generate the full set (`icon.ico` + all-size PNGs).

**3-color status icons** (`icons/tray-*.png`, runtime tray switching): based on the same geometric language:
- green = healthy (solid / full)
- yellow = reconnecting (semi-transparent / pulse-style outline)
- red = fault (hollow / warning-color outline)

Size follows existing convention (16×16 / 32×32 for tray; Tauri handles DPI).

### 4.5 Change Summary

| File | Change |
|------|--------|
| `daemon_runner.rs` | `build_spawn_config` add `bundled_node_path` priority; add `chrome_installed` pre-check |
| `src-tauri/src/webview2_check.rs` | **New** — WebView2 missing detection + guide |
| `src-tauri/src/main.rs` / `app.rs` | Call `ensure_webview2` at startup |
| `tauri.conf.json` | `resources` add `node/node.exe`, `daemon/*`, `MicrosoftEdgeWebview2Setup.exe` |
| `src-tauri/icons/*` | Redesign full set (ico + png) |
| `icons/tray-*.png` | Redesign 3-color status icons |
| `README.txt` / `README-EN.txt` | **New** — Chinese/English quick-start |

## 5. Build Script

### 5.1 Script: `packages/tray-app/scripts/package-win.mjs`

Node script triggered by `pnpm package:win`. Four phases:

**Phase 1 — pre-build (produce daemon bundle + exe):**

```mjs
// 1a. daemon bundle (pnpm build already does this via turbo, ensure fresh)
await run('pnpm', ['build'], repoRoot)
// 1b. Tauri build — produces bare exe with resources embedded
await run('pnpm', ['tauri', 'build'], trayDir)  // -> src-tauri/target/release/ma-browser-tray.exe
```

**Phase 2 — assemble staging dir:**

`tauri build` produces a bare exe; resources are embedded into the exe. For portable mode, `resource_dir()` returns the exe's parent directory (not an AppData install dir). So assemble resources **sibling to the exe**:

```mjs
const staging = 'dist/portable-staging/ma-browser-tray'
copy(exeBuildOutput, `${staging}/ma-browser-tray.exe`)
copy('packages/daemon/dist/index.js', `${staging}/daemon/`)
copy('packages/daemon/src/buildDomTree.js', `${staging}/daemon/`)
copyDir('packages/daemon/node_modules/ws', `${staging}/daemon/node_modules/ws`)
ensureNodeExe(`${staging}/node/node.exe`)
copy('vendor/MicrosoftEdgeWebview2Setup.exe', `${staging}/`)
copyDir('icons', `${staging}/icons`)
copy('README.txt', staging); copy('README-EN.txt', staging)
```

**Phase 3 — fetch node.exe (bundled Node):**

node.exe is not in git (too large). Script downloads from official source with cache:

```mjs
async function ensureNodeExe(dest) {
  const NODE_VERSION = 'v20.15.0'  // pinned LTS, aligned with dev env
  const url = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`
  const cache = `.cache/node-${NODE_VERSION}-win-x64.zip`
  if (!exists(cache)) await download(url, cache)
  await extractFile(cache, 'node.exe', dest)  // extract only node.exe, discard rest
}
```

**Version pinned** as a constant at script top. Upgrade = change one constant. `.cache/` added to `.gitignore`.

**Phase 4 — zip:**

```mjs
const version = readVersionFromTauriConf()
await zipDir(staging, `dist/ma-browser-tray-portable-v${version}.zip`)
```

### 5.2 `package.json` script

```json
{
  "scripts": {
    "package:win": "node scripts/package-win.mjs"
  }
}
```

In `packages/tray-app/package.json`. `cd packages/tray-app && pnpm package:win` → `packages/tray-app/dist/ma-browser-tray-portable-v{VERSION}.zip`.

### 5.3 Vendored file: `vendor/MicrosoftEdgeWebview2Setup.exe`

The bootstrapper (~2MB) is placed manually into `packages/tray-app/vendor/` (Microsoft does not allow programmatic auto-download). **Git-tracked** (2MB acceptable). Script assumes it exists; on absence throws an error telling where to download.

### 5.4 Build-machine prerequisites

Build machine needs: **Rust + Tauri CLI + Node** (to run `tauri build`). These are build-machine requirements, not end-user requirements. End user gets the zip and needs nothing except Chrome.

## 6. Documentation

### 6.1 `README.txt` / `README-EN.txt` (in zip, for end users)

In zip root, double-click to read. Minimal, 30-second read. Chinese and English share structure.

**Chinese structure:**

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

卸载: 删除整个解压目录即可(不写注册表)

注: 首次运行 Windows SmartScreen 可能提示"已保护你的电脑",
点"更多信息"→"仍要运行"即可(本程序未购买代码签名证书)。
```

**English version same structure.** Key sentence: `Extract → double-click exe → tray turns green → copy MCP config`. English version also includes the SmartScreen note: `On first run Windows SmartScreen may warn; click "More info" → "Run anyway" (this app is not code-signed).`

### 6.2 `docs/tray-app-packaging.md` (in repo, for developers/packagers)

Records reproducible build steps:

```
# Tray-App Packaging Guide

## Prerequisites (build machine)
- Rust toolchain (rustup)
- Tauri CLI (pnpm tauri)
- Node.js 20+
- pnpm

## One-time setup
1. Place MicrosoftEdgeWebview2Setup.exe into packages/tray-app/vendor/
   Download: https://developer.microsoft.com/.../webview2

## Build
cd packages/tray-app
pnpm package:win
# -> dist/ma-browser-tray-portable-v{VERSION}.zip

## Artifact structure
(zip layout)

## Upgrade bundled Node
Change NODE_VERSION constant at top of scripts/package-win.mjs, delete .cache/, rerun

## Verify
See docs/tray-app-smoke-test.md
```

### 6.3 `docs/tray-app-smoke-test.md` (in repo, for verifiers)

Executable steps for clean-environment smoke test (corresponds to §7 verification):

```
# Smoke Test Checklist (Win10 clean environment)

## Environment
- Win10 1903+ fresh VM (no Node / no WebView2 / has Chrome)

## Steps
1. Extract zip to C:\ma-browser-tray
2. Double-click ma-browser-tray.exe
3. [Expected] If WebView2 missing, popup -> confirm -> auto-install -> restart exe
4. [Expected] Tray icon appears, turns green within 10s
5. Right-click tray -> "Copy MCP config" -> clipboard has daemon URL + token
6. Configure Claude Code, run one browser snapshot
7. [Expected] snapshot returns page info, tray shows activity

## Pass criteria
Steps 4 + 6 green = pass
```

### 6.4 Language convention

Per AGENTS.md: "user-facing text in Chinese, code/comments in English". `README.txt` Chinese-primary, `README-EN.txt` English. Both developer docs (`packaging.md`, `smoke-test.md`) in English (developer-facing, matching code-comment language).

## 7. Verification

### 7.1 Post-build auto-check — built into `package-win.mjs`

After zip is produced, the script auto-runs a structure check (does **not** launch the exe — the local machine is not clean, so launching would be untrustworthy):

```mjs
function verifyZipStructure(zipPath) {
  const required = [
    'ma-browser-tray/ma-browser-tray.exe',
    'ma-browser-tray/MicrosoftEdgeWebview2Setup.exe',
    'ma-browser-tray/node/node.exe',
    'ma-browser-tray/daemon/index.js',
    'ma-browser-tray/daemon/buildDomTree.js',
    'ma-browser-tray/daemon/node_modules/ws/index.js',
    'ma-browser-tray/icons/tray-green.png',
    'ma-browser-tray/icons/tray-red.png',
    'ma-browser-tray/icons/tray-yellow.png',
    'ma-browser-tray/README.txt',
    'ma-browser-tray/README-EN.txt',
  ]
  // Extract to temp dir, assert each exists
  // Any missing -> throw, build fails
}
```

Guarantees **artifact completeness, no missing files**. Runs on every `pnpm package:win`; on failure no zip is produced.

### 7.2 Clean-environment smoke test — pre-release, manual

Per `docs/tray-app-smoke-test.md`. Core pass criteria:

| Step | Expected | On failure, investigate |
|------|----------|-------------------------|
| Double-click exe (no WebView2) | Popup → confirm → auto-install WebView2 | `webview2_check.rs` guide logic |
| Tray icon | Green within 10s | `daemon_runner.rs` bundled node location |
| Right-click → copy MCP config | Clipboard has URL + token | daemon `/status` works |
| Configure Claude Code, run snapshot | Returns page info | CDP + Chrome connectivity |

**Critical assertion:** the smoke-test machine **deliberately has no Node.js**, proving the bundled node works — this is the core "fully self-contained" assertion.

### 7.3 Known Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Bundled node path contains spaces (`C:\Users\My Name\...`) → spawn fails | `daemon_runner.rs` existing comment notes this; use `Command::new(abs_path)` (reliable), keep bare-name node fallback; smoke test under a space-containing path |
| `resource_dir()` returns uncertain value in portable mode | Build script assembles resources sibling to exe (compatible with `resource_dir` = exe parent); add logging of actual `resource_dir` value during implementation |
| WebView2 bootstrapper needs network | README states "first run needs network for WebView2"; only networking point, acceptable |
| node.exe version incompatible with daemon bundle Node API | Pin LTS v20, aligned with dev/CI env; rerun smoke test when upgrading the constant |

## 8. Auto-Update Mechanism

> Added in a second brainstorming pass. The tray-app now detects new releases and guides the user to manually replace the portable zip. There is **no** automatic download/file-swap — that is incompatible with the portable exe model (a running exe cannot self-replace, there is no fixed install path, and a failed background swap has no rollback).

### 8.1 Confirmed Decisions

| Decision | Choice |
|----------|--------|
| Update granularity | **Detect only + guide manual replacement** |
| Detection channel | **GitHub Releases API** |
| Version source | **Unified to `package.json`** (eliminates the hardcoded `0.0.1`) |
| Detection timing | **On startup (background async) + manual menu item** |
| Notification form | **Menu text label only** ("🆕 有新版本 vX.Y.Z", click opens release page) |

### 8.2 Mechanism & Data Flow

```
tray startup
  └─ background async task (tauri::async_runtime::spawn)
       ├─ read current version (compile-time injected, source = package.json)
       ├─ HTTP GET https://api.github.com/repos/zzhan111/multi-agents-browser/releases/latest
       ├─ parse release tag_name (e.g. "v0.12.0")
       ├─ semver compare: latest > current ?
       └─ yes → store {latestVersion, releaseUrl, downloadUrl} in TrayState
                 → menu refresh: insert clickable "🆕 有新版本 vX.Y.Z" item above About
          no  → no notification

user clicks menu item → tauri-plugin-opener opens releaseUrl in browser
                      → user downloads new zip → exits tray → extracts/replaces dir → restarts
```

**No auto-download/swap rationale (portable constraint):**
- A running portable exe holds its own file open; it cannot self-delete/replace.
- No fixed install path — a background swap script cannot reliably locate the target.
- A failed auto-restart has no rollback (no installer backup, unlike NSIS).
- "Guide manual replacement" shifts these risks to the user, consistent with the portable philosophy.

**GitHub Releases API robustness:**
- Network failure / timeout (5s) → silent abort, does not affect startup.
- Non-200 / parse failure → silent abort.
- Rate limit (403, 60 req/hr unauthenticated) → silent on startup; on manual menu click, if still limited the menu shows "检查失败,稍后再试".
- Fully offline environment → feature silently unavailable, no error (normal for portable offline use).

**Semver comparison:** lightweight `major.minor.patch` parse + numeric compare (no extra crate). Release tags conventionally `vX.Y.Z`; strip leading `v`. No pre-release tag handling in MVP (release tags are clean).

### 8.3 Version Unification — eliminate hardcoded `0.0.1`

Current tray-app version `0.0.1` is hardcoded in 3 places (`tauri.conf.json:4`, `Cargo.toml:3`, `app.rs:337` About dialog), disconnected from npm `0.11.6`. Unified source = `package.json`.

**New `src-tauri/build.rs`** — reads root `package.json` version, sets cargo env var:
```rust
fn main() {
    let manifest = std::fs::read_to_string("../../package.json").expect("read package.json");
    let version = /* parse .version */;
    println!("cargo:rustc-env=BB_BROWSER_VERSION={}", version);
}
```

**Consumed in 3 places:**
- `app.rs:337` About dialog `"版本: 0.0.1\n\n"` → `concat!("版本: ", env!("BB_BROWSER_VERSION"), "\n\n")`.
- `tauri.conf.json` / `Cargo.toml` version fields → synced by `package-win.mjs` (§8.6) before build, from `package.json`.
- `update_checker.rs::current_version()` returns `env!("BB_BROWSER_VERSION")`.

Single source of truth = `package.json`. `build.rs` (compile-time Rust value) + build script (conf files) both read it.

### 8.4 New `update_checker.rs` Module

```rust
// src-tauri/src/update_checker.rs
const RELEASE_REPO: &str = "zzhan111/multi-agents-browser";

pub struct UpdateInfo {
    pub latest_version: String,   // "0.12.0" (no v prefix)
    pub release_url: String,      // https://github.com/zzhan111/multi-agents-browser/releases/tag/v0.12.0
    pub download_url: String,     // direct zip asset URL
}

/// Current app version, injected at build time from package.json.
pub fn current_version() -> &'static str {
    env!("BB_BROWSER_VERSION")
}

/// Fetch latest release from GitHub. None on any failure (silent).
pub async fn check_latest(repo: &str) -> Option<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    // reqwest GET with User-Agent (GitHub requires), 5s timeout
    // parse tag_name, html_url, assets[].browser_download_url (zip)
    // strip leading 'v' from tag_name
}

/// Compare semver: latest > current ?
pub fn is_newer(latest: &str, current: &str) -> bool {
    // parse "major.minor.patch", numeric compare
}
```

**Dependency:** `reqwest` (async). If Tauri v2 does not already pull it transitively, add to `Cargo.toml` with `default-features = false` + `rustls-tls` to minimize size (~+2MB acceptable).

### 8.5 Tray Integration — `app.rs`

**Startup detection** in `setup()`:
```rust
let app_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    if let Some(info) = update_checker::check_latest(update_checker::RELEASE_REPO).await {
        if update_checker::is_newer(&info.latest_version, update_checker::current_version()) {
            // store in TrayState, refresh menu
        }
    }
    // any failure path silent — network unreachable is normal
});
```

**Menu items** (new IDs alongside existing `app.rs:33-42`):
- `check_update` — always-present "检查更新"; click triggers `check_latest` manually, on rate-limit shows "检查失败,稍后再试".
- `update_available` — dynamically shown only when an update is detected; label = `format!("🆕 有新版本 v{}", info.latest_version)`; click → `tauri-plugin-opener` opens `release_url`.

```
Menu structure (inserted above About):
  ─────────────
  状态: 运行中
  ─────────────
  检查更新          ← check_update (always present)
  🆕 有新版本 vX.Y.Z  ← update_available (only when update detected)
  关于              ← About version now from env!()
  退出
```

**`tray_state.rs`:** add `pub update_info: Option<UpdateInfo>` field; menu builder reads it to decide whether to show the `update_available` item.

**About dialog fix:** `app.rs:337` currently links to `github.com/anthropics/ma-browser` (incorrect). Fix to `github.com/zzhan111/multi-agents-browser`.

### 8.6 Build Script Changes — `package-win.mjs`

Add a **Phase 0 — version sync** before the existing Phase 1:
```mjs
// Phase 0: version sync — package.json is single source of truth
function syncVersion() {
  const version = readJson('package.json').version  // "0.11.6"
  patchFile('packages/tray-app/src-tauri/Cargo.toml', /version = ".*"/, `version = "${version}"`)
  patchJson('packages/tray-app/src-tauri/tauri.conf.json', { version })
}
```
`build.rs` (compile-time Rust value) + script (conf files) both read `package.json` — double insurance, consistent.

### 8.7 Documentation Changes

**`README.txt` / `README-EN.txt`** add an update section:
```
6. 更新:
   - 有新版本时,右键托盘菜单会显示 "🆕 有新版本 vX.Y.Z"
   - 点击该项打开下载页,下载新 zip
   - 退出当前程序(右键→退出),解压新 zip 替换整个目录,重新双击 exe
```

**`docs/tray-app-packaging.md`** add a "Release a new version" section:
```
## Release a new version
1. Bump version in package.json
2. git tag vX.Y.Z && git push origin vX.Y.Z
3. pnpm package:win → produces zip
4. Create Release on GitHub (zzhan111/multi-agents-browser), tag = vX.Y.Z
5. Upload zip to Release assets
6. User tray detects the new version on next startup
```

**`docs/tray-app-smoke-test.md`** add:
```
8. [Expected] Tray menu shows "检查更新", clicking no error (network available)
9. [Expected] About dialog version = package.json version (not 0.0.1)
```

### 8.8 Verification

| Item | Method |
|------|--------|
| Version unified | smoke test step 9: About shows package.json version |
| Detection does not block startup | time double-click → tray icon < 3s (GitHub API is background async) |
| Network unreachable silent | start tray offline, no error popup, "检查更新" click shows "检查失败,稍后再试" |
| Update detected | set current version below an already-published release (temporarily lower package.json), menu shows "🆕 有新版本" |
| Menu click opens release page | click → browser opens `github.com/zzhan111/multi-agents-browser/releases/tag/vX.Y.Z` |

### 8.9 Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| GitHub API rate limit (60/hr unauthenticated) | startup + manual click only, low frequency; on limit, menu shows "稍后再试" not error |
| GitHub unreachable (enterprise intranet / firewall) | silent failure, feature unavailable but core (daemon/Chrome) unaffected |
| package.json version diverges from published Release (forgot to publish) | does not affect detection (queries latest release); developer doc makes release flow explicit |
| reqwest increases exe size | common dep, possibly already transitive; if added ~+2MB, acceptable |

### 8.10 Change Summary (auto-update additions)

| File | Change |
|------|--------|
| `src-tauri/build.rs` | **New** — read package.json, inject `BB_BROWSER_VERSION` |
| `src-tauri/src/update_checker.rs` | **New** — `check_latest` / `is_newer` / `current_version` / `RELEASE_REPO` |
| `src-tauri/src/app.rs` | startup spawn detection; new `check_update`/`update_available` menu items + handlers; About version → `env!()`; fix About repo link |
| `src-tauri/src/tray_state.rs` | add `update_info: Option<UpdateInfo>` |
| `src-tauri/Cargo.toml` | add `reqwest` (if not transitive); version synced by script |
| `src-tauri/tauri.conf.json` | version synced by script |
| `scripts/package-win.mjs` | Phase 0 version sync; build.rs reads package.json |
| `README.txt` / `README-EN.txt` | add update section |
| `docs/tray-app-packaging.md` | add release flow section |
| `docs/tray-app-smoke-test.md` | add update + version check steps |

## 9. Portable MCP Access (Coding-Agent Onboarding)

> Added in a third brainstorming pass. The portable zip bundles the MCP server and a machine-readable config so a coding agent (Claude Code / Cursor / Cline) can discover and self-configure its MCP client by reading files in the extracted directory — no manual config pasting required, while still offering a manual "copy config" fallback.

### 9.1 The Gap This Closes

Without this section, the portable zip can control Chrome (daemon works) but **coding agents cannot connect to it**: (a) there is no global `ma-browser` on PATH, so the npm `npx -y ma-browser --mcp` config does not work; (b) the MCP server bundle (`mcp.js`) was not in the zip; (c) no "Copy MCP config" menu item exists in `app.rs` (the earlier plan assumed it did). The fix bundles `mcp.js`, generates a machine-readable `mcp-config.json`, and adds the menu item.

### 9.2 Confirmed Decisions

| Decision | Choice |
|----------|--------|
| MCP entry layout | **Dedicated `mcp/` subdirectory** (sibling to `daemon/`) |
| MCP ↔ daemon relation | **Connect-only** (`MA_BROWSER_CONNECT_ONLY=1`); the tray is the sole daemon owner |
| Config delivery | **Dual-track**: `mcp-config.json` (agent self-configures) + tray "Copy MCP config" menu (human fallback) |
| Agent discovery | **`mcp-config.json` + README instruction** |

### 9.3 mcp-config.json — Machine-Readable Access Descriptor

**Template (written at packaging time, contains a placeholder):**

```json
{
  "mcpServers": {
    "ma-browser": {
      "command": "<APP_DIR>\\node\\node.exe",
      "args": ["<APP_DIR>\\mcp\\mcp.js"],
      "env": { "MA_BROWSER_CONNECT_ONLY": "1" }
    }
  },
  "_meta": {
    "description": "ma-browser MCP server (connect-only; connects to the tray-owned daemon via ~/.bb-browser/daemon.json)",
    "app_dir_placeholder": "<APP_DIR>",
    "requires_daemon_running": true,
    "daemon_status_hint": "Tray icon must be green (daemon running) before MCP calls will succeed"
  }
}
```

**Runtime placeholder fill:** on first startup the tray reads `mcp-config.json` from `resource_dir()`, replaces `<APP_DIR>` with the actual extraction root (`current_exe().parent()`), and writes it back to the same file. After this, the file a coding agent reads contains directly-usable absolute paths — the agent does not need to substitute anything.

**Coding-agent onboarding flow:**
1. User tells the coding agent "use ma-browser" and points it at the extraction directory.
2. The agent reads `<extracted-dir>/mcp-config.json`, parses `mcpServers.ma-browser`.
3. The agent writes that server config into its own MCP config file (Claude Code's `claude_desktop_config.json`, Cursor's `.cursor/mcp.json`, etc.).
4. The agent launches the MCP server via the config's `command`/`args`; the server runs with `MA_BROWSER_CONNECT_ONLY=1` and connects to the tray-owned daemon via `~/.bb-browser/daemon.json`.

### 9.4 Tray "Copy MCP config" Menu (Human Fallback)

New menu item `copy_mcp_config`: on click, calls the existing `copy_text` IPC command with the `mcpServers` portion of the (already-filled) `mcp-config.json` as the clipboard payload. Lets a user manually paste the config into their agent's config file.

Menu position (next to "检查更新"):
```
  ─────────────
  状态: 运行中
  ─────────────
  复制 MCP 配置        ← copy_mcp_config (new)
  检查更新
  🆕 有新版本 vX.Y.Z
  关于
  退出
```

### 9.5 Code Changes

| File | Change |
|------|--------|
| `scripts/package-win.mjs` | Phase 2: copy `dist/mcp.js` → `staging/mcp/mcp.js`; write `mcp-config.json` template (with `<APP_DIR>` placeholder) to staging root. `verifyStructure`: add `mcp/mcp.js` + `mcp-config.json` to required list. |
| `src-tauri/src/mcp_config.rs` | **New** — `fill_placeholders(app)`: read `resource_dir/mcp-config.json`, replace `<APP_DIR>` → actual path, write back. `mcp_servers_json(app)`: return the filled `mcpServers` JSON string for clipboard copy. |
| `src-tauri/src/app.rs` | New `ID_COPY_MCP_CONFIG` menu item + handler (reads filled mcp-config.json, copies mcpServers via `copy_text`); call `mcp_config::fill_placeholders` at startup. |
| `src-tauri/src/main.rs` | Declare `mod mcp_config;` behind `#[cfg(feature = "tauri-app")]`. |
| `tauri.conf.json` `resources` | Add `resources/mcp/**` and `resources/mcp-config.json` (script stages these into `src-tauri/resources/` before `tauri build`). |

### 9.6 Documentation Changes

**`README.txt` / `README-EN.txt`** step 4 rewritten:
```
4. 让你的 AI 客户端接入(两种方式):
   方式 A(推荐,让 AI 自动配置):
     告诉你的 AI:"用 ma-browser,配置文件在 <解压目录>\mcp-config.json"
     AI 会读取该文件并自行配置 MCP。
   方式 B(手动):
     右键托盘 → "复制 MCP 配置" → 粘贴到你 AI 客户端的配置文件
   注意:接入前确保托盘图标为绿色(daemon 运行中)。
```

**`docs/tray-app-packaging.md`** add a section documenting the `mcp-config.json` generation + placeholder-fill mechanism.

### 9.7 Verification

| Item | Method |
|------|--------|
| mcp.js bundled | structure check: `mcp/mcp.js` present in zip |
| mcp-config.json present + filled | after first tray run, `mcp-config.json` contains no `<APP_DIR>` (replaced with real path) |
| Agent can launch MCP server | from the extracted dir, run `<dir>\node\node.exe <dir>\mcp\mcp.js` with `MA_BROWSER_CONNECT_ONLY=1`; connects to daemon (tray green); a `browser snapshot` via the MCP client returns page info |
| Copy menu works | right-click → "复制 MCP 配置" → clipboard contains valid `mcpServers` JSON with absolute paths |

## 10. Out of Scope (MVP)

- Auto-start on boot (menu item hidden; user can manually drop a shortcut into the Startup folder)
- NSIS / MSI installer (portable zip only this round)
- Bundled Chromium (would destroy the login-state reuse value)
- Code-signed exe (no cert acquired yet; SmartScreen may warn on first run — documented in README)
- **Automatic** download/file-swap update (§8 provides detect + guide-manual-replacement; full auto-swap is incompatible with the portable model and deferred)
