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

## 3. Product — Target & Artifact Layout

### 3.1 Target

One portable zip. End user on Win10+ clean machine: extract → double-click `ma-browser-tray.exe` → built-in Node daemon starts → connects to user's Chrome → tray icon turns green. No pre-installed Node, no admin, no networking except first-run WebView2 bootstrap.

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
    ├── icons/
    │   ├── tray-green.png
    │   ├── tray-red.png
    │   └── tray-yellow.png
    ├── README.txt                        # Chinese quick-start
    └── README-EN.txt                     # English quick-start
```

**Estimated size:** ~55MB (node.exe 40 + daemon bundle 1 + ws 0.5 + webview2 bootstrapper 2 + exe 10 + icons). Acceptable.

**Key:** `node/`, `daemon/`, `MicrosoftEdgeWebview2Setup.exe` are all Tauri resources, located at runtime via `resource_dir()` — consistent with `daemon_runner.rs` existing `locate_daemon_entry` logic.

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

## 8. Out of Scope (MVP)

- Auto-start on boot (menu item hidden; user can manually drop a shortcut into the Startup folder)
- NSIS / MSI installer (portable zip only this round)
- Bundled Chromium (would destroy the login-state reuse value)
- Code-signed exe (no cert acquired yet; SmartScreen may warn on first run — documented in README)
- Auto-update mechanism (manual zip replacement for now)
