# @bb-browser/tray-app

Windows system tray daemon UI for bb-browser.

## Architecture

This is a **Tauri v2** application that manages the Windows system tray presence and provides UI for the bb-browser daemon.

```
packages/tray-app/
├── src-tauri/              # Rust backend (Tauri main process)
│   ├── src/main.rs         # Tray icon, daemon subprocess spawning
│   ├── Cargo.toml
│   └── tauri.conf.json     # Tauri configuration
└── src/                    # Frontend (WebView2)
    ├── index.html          # Popup window UI
    ├── styles.css          # Acrylic-based styling
    └── main.js             # Frontend logic
```

## Phase 1 Scope

- [x] Tauri v2 scaffold setup
- [ ] Daemon subprocess spawning (`packages/daemon` as subprocess)
- [ ] Port discovery (19824/19825 HTTP + CDP debug ports)
- [ ] Tray icon with 3-color states (connected/warning/error)
- [ ] Basic popup (360×320px, Acrylic material)
- [ ] Toast notifications (Windows 11 native)
- [ ] Right-click context menu
- [ ] Self-healing (3 failure recovery types)

See [docs/system-tray-design.md](../../docs/system-tray-design.md) §5–10 for detailed design.

## Development

```bash
cd packages/tray-app
pnpm install
pnpm dev
```

## References

- Design spec: [docs/system-tray-design.md](../../docs/system-tray-design.md)
- Deferred features: [docs/system-tray-future.md](../../docs/system-tray-future.md)
- Implementation decisions: [docs/system-tray-design.md §14](../../docs/system-tray-design.md)
