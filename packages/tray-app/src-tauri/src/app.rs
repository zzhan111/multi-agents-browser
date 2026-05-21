//! Tauri application shell.
//!
//! This module is only compiled with `--features tauri-app`. It wires the
//! pure-logic library (`bb_browser_tray::*`) into the Tauri runtime:
//!
//! - Phase 2.1 (this file): bootstrap the Tauri app + register a tray icon
//!   with placeholder behavior. Proves `cargo build --features tauri-app`
//!   produces a runnable GUI binary on Windows.
//! - Phase 2.3+: hook the tray icon updates to the supervisor state.

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

/// Entry point invoked by `main.rs`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Light-dismiss: popup closes on focus loss.
            if let WindowEvent::Focused(false) = event {
                if window.label() == "popup" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Build the tray icon + right-click menu.
///
/// Phase 2.1 sentinel: red icon ("not running" — until the supervisor
/// reports otherwise) with a stub menu that proves wiring works.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    // --- Right-click menu (Phase 2.4 will expand this) ---
    let restart =
        MenuItem::with_id(app, "restart", "重启 daemon", true, Some("Ctrl+R"))?;
    let open_logs =
        MenuItem::with_id(app, "open_logs", "打开日志文件夹", true, Some("Ctrl+L"))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let about = MenuItem::with_id(app, "about", "关于 bb-browser", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, Some("Ctrl+Q"))?;
    let menu = Menu::with_items(app, &[&restart, &open_logs, &sep1, &about, &quit])?;

    // --- Tray icon (red placeholder until supervisor is wired) ---
    let icon = load_tray_icon(app, "red");

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("bb-browser · 未运行")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            // Phase 2.4 will replace these with real handlers.
            match event.id.as_ref() {
                "restart" => eprintln!("[tray] menu: restart (TODO)"),
                "open_logs" => eprintln!("[tray] menu: open_logs (TODO)"),
                "about" => eprintln!("[tray] menu: about (TODO)"),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click = popup; middle-click = toggle daemon (Phase 2.5+).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("popup") {
                    // Toggle visibility on subsequent clicks.
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                } else {
                    eprintln!("[tray] popup window not yet built (Phase 2.5)");
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Load a tray icon by color name ("red" / "yellow" / "green").
///
/// PNGs ship in `src-tauri/icons/tray-<color>.png` and are bundled via
/// `tauri.conf.json` -> `bundle.resources`.
fn load_tray_icon(app: &AppHandle, color: &str) -> Image<'static> {
    let path = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join(format!("icons/tray-{color}.png")))
        .filter(|p| p.exists())
        // Dev fallback: source-relative path.
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .join("icons")
                .join(format!("tray-{color}.png"))
        });

    Image::from_path(&path).unwrap_or_else(|e| {
        eprintln!("[tray] failed to load icon {path:?}: {e}");
        // Fallback: 1×1 transparent so the app still starts.
        Image::new_owned(vec![0, 0, 0, 0], 1, 1)
    })
}
