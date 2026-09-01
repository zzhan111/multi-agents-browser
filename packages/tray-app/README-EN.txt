ma-browser Browser Agent — Quick Start
======================================

1. Extract this zip to any folder (no installer, no admin required)

2. Double-click ma-browser-tray.exe
   - On first run, if prompted about a missing WebView2, click OK to
     auto-install it, then double-click the exe again
   - Tray icon turns green = ready

3. Google Chrome is required (to reuse your login state)
   - Not installed? Download: https://www.google.com/chrome/

4. Configure your AI client (Claude Code / Cursor / Cline) — two ways:
   Way A (recommended, let the AI self-configure):
     Tell your AI: "use ma-browser, the config file is at
     <extracted-dir>\mcp-config.json"
     The AI reads the file and configures MCP itself.
   Way B (manual):
     Right-click the tray → "复制 MCP 配置" → paste into your AI client's
     config file.
   Note: ensure the tray icon is green (daemon running) before connecting.

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
