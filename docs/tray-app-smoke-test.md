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
5. Right-click the tray → click "复制 MCP 配置" → the clipboard contains a
   valid `mcpServers` JSON object with absolute paths (no `<APP_DIR>`).
6. Verify `mcp-config.json` in the extracted dir has `<APP_DIR>` replaced
   with the real path (e.g. `C:\ma-browser-tray\node\node.exe`).
7. Launch the MCP server manually to confirm it connects:
   ```
   set MA_BROWSER_CONNECT_ONLY=1
   C:\ma-browser-tray\node\node.exe C:\ma-browser-tray\mcp\mcp.js
   ```
   **[Expected]** It starts without error and does NOT spawn a second daemon
   (connect-only). Stop it (Ctrl+C).
8. Configure Claude Code with the copied MCP config; run one `browser snapshot`.
9. **[Expected]** The snapshot returns page info; the tray shows activity.
10. **[Expected]** The tray menu shows "检查更新"; clicking it does not error
    (when network is available).
11. **[Expected]** Right-click → About shows a version equal to `package.json`'s
    version (NOT `0.0.1`).

## Pass criteria

Steps 4, 8, and 11 green = pass. The space-in-path variant (step 1) must also
pass for the bundled-node fix to be considered validated.

## Failure triage

| Symptom | Investigate |
|---------|-------------|
| Step 3: no popup, exe silently dies | `webview2_check.rs` registry detection; bootstrapper path |
| Step 4: icon stays red | `daemon_runner.rs` bundled-node resolution; check `%USERPROFILE%\.bb-browser\` logs |
| Step 4: icon yellow forever | daemon started but Chrome not found; `chrome_installed()` pre-check |
| Step 6: mcp-config.json still has `<APP_DIR>` | `mcp_config::fill_placeholders` not running at startup; resource_dir path |
| Step 7: MCP server spawns its own daemon | `MA_BROWSER_CONNECT_ONLY` env not propagated; mcp.js connect-only logic |
| Step 8: snapshot fails | CDP connectivity; token in daemon.json; MCP server not in connect-only mode |
| Step 11: shows `0.0.1` | `build.rs` `BB_BROWSER_VERSION` injection; `package-win.mjs` Phase 0 |
