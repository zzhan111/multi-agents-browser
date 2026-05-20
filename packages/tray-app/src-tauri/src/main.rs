// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, Runtime, State, Window,
};
use std::process::Command;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // TODO: Phase 1 initialization
            // - Spawn Node daemon subprocess
            // - Setup daemon port discovery
            // - Initialize tray icon and menu

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
