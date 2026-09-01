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
- Phase 1: `pnpm build` (daemon + mcp bundles) + `tauri build` (exe with embedded resources)
- Phase 2: assembles a staging dir (exe + daemon + mcp + node + icons + README + mcp-config.json)
- Phase 3: downloads the pinned Node.js LTS, extracts `node.exe` (cached in `.cache/`)
- Phase 4: zips the staging dir + verifies all required files are present

## Artifact structure

```
ma-browser-tray/
├── ma-browser-tray.exe
├── MicrosoftEdgeWebview2Setup.exe
├── node/node.exe
├── daemon/{index.js, buildDomTree.js, node_modules/ws/}
├── mcp/mcp.js
├── mcp-config.json
├── icons/{tray-green,red,yellow}.png
├── README.txt
└── README-EN.txt
```

## MCP config (coding-agent onboarding)

The zip ships `mcp-config.json` with a `<APP_DIR>` placeholder. On first
tray startup, `mcp_config::fill_placeholders` replaces `<APP_DIR>` with the
actual extraction root and writes it back, so coding agents read a
directly-usable `mcpServers` block (absolute `node.exe` + `mcp.js` paths,
`MA_BROWSER_CONNECT_ONLY=1`). The tray also offers a "复制 MCP 配置" menu
item as a human manual-copy fallback. See spec §9.

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
