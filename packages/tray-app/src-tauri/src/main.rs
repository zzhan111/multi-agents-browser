// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "tauri-app")]
fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // TODO: Phase 1 — wire up supervisor, port discovery, tray icon.
            // Implementation lives in the bb_browser_tray library crate.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(not(feature = "tauri-app"))]
fn main() {
    eprintln!(
        "bb-browser-tray was built without the `tauri-app` feature. \
         Rebuild with `cargo build --features tauri-app` to produce the GUI binary."
    );
    std::process::exit(2);
}
