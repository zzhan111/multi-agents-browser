//! Pre-start WebView2 Runtime check.
//!
//! Tauri depends on WebView2 (pre-installed on Win11, may be absent on Win10).
//! When missing, Tauri fails ungracefully. This module checks the official
//! registry key and, if absent, prompts the user via a native dialog and
//! launches the bundled Evergreen Bootstrapper (MicrosoftEdgeWebview2Setup.exe
//! shipped as a Tauri resource alongside the exe).
//!
//! Detection is intentionally multi-pronged: the WebView2 Runtime client GUID
//! registers under HKLM\WOW6432Node on a per-machine install, but per-user
//! installs land under HKCU. Different Win10 versions also vary, so we check
//! both hives AND fall back to a disk check (the installed version directory).

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The WebView2 Runtime client GUID (per Microsoft Edge Update docs).
/// NOTE: this is `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` — the Runtime
/// client. (A similar-looking GUID with `8BFF-9B32` is a *different* client
/// and must NOT be used; checking the wrong GUID makes a present Runtime
/// appear missing.)
const WEBVIEW2_CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_REG_VALUE: &str = "pv";

/// True if a WebView2 runtime is installed. Checks the official registry key
/// under both HKLM (WOW6432Node + 64-bit view) and HKCU, then falls back to a
/// disk check for the installed version directory. Any hit → installed.
pub fn is_installed() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        let guid_path = format!(
            r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{}",
            WEBVIEW2_CLIENT_GUID
        );
        let guid_path_64 = format!(
            r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{}",
            WEBVIEW2_CLIENT_GUID
        );
        // 1. HKLM WOW6432Node (per-machine, 32-bit view — the common case).
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(&guid_path) {
            let pv: Option<String> = key.get_value(WEBVIEW2_REG_VALUE).ok();
            if matches!(pv, Some(v) if !v.is_empty()) {
                return true;
            }
        }
        // 2. HKLM 64-bit view.
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(&guid_path_64) {
            let pv: Option<String> = key.get_value(WEBVIEW2_REG_VALUE).ok();
            if matches!(pv, Some(v) if !v.is_empty()) {
                return true;
            }
        }
        // 3. HKCU (per-user install, common on Win10 Evergreen).
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&guid_path_64) {
            let pv: Option<String> = key.get_value(WEBVIEW2_REG_VALUE).ok();
            if matches!(pv, Some(v) if !v.is_empty()) {
                return true;
            }
        }
        // 4. Disk fallback: the installed version directory exists.
        if disk_install_present() {
            return true;
        }
        false
    }
    #[cfg(not(windows))]
    {
        // non-Windows: no WebView2 concept; assume present.
        true
    }
}

/// Disk-level fallback: look for the EdgeWebView Application version directory
/// in the three standard install locations. Catches installs whose registry
/// entries are missing or under a hive we can't read.
#[cfg(windows)]
fn disk_install_present() -> bool {
    use std::path::Path;
    let candidates: Vec<Option<std::ffi::OsString>> = vec![
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LOCALAPPDATA"),
    ];
    for base in candidates.into_iter().flatten() {
        let app_dir = Path::new(&base).join("Microsoft").join("EdgeWebView").join("Application");
        if app_dir.is_dir() {
            // A version subdir (e.g. "149.0.4022.80") means it's actually installed.
            if let Ok(entries) = std::fs::read_dir(&app_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.chars().next().map_or(false, |c| c.is_ascii_digit()) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// If WebView2 is missing, prompt the user and launch the bootstrapper.
/// Returns true if a bootstrapper was launched (caller should exit so the
/// installer can run + the user can restart the app). Returns false if
/// WebView2 is already installed OR the user declined OR the bootstrapper is
/// unavailable.
pub fn ensure_installed(app: &AppHandle) -> bool {
    if is_installed() {
        return false;
    }
    let bootstrapper = bundled_bootstrapper_path(app);
    eprintln!(
        "[webview2] WebView2 Runtime not found; bootstrapper at {:?}",
        bootstrapper
    );
    // Blocking modal dialog so we get the user's choice before proceeding.
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let accepted = app.dialog()
        .message(
            "运行本程序需要 WebView2 Runtime,当前未检测到。\n\
             点击“确定”自动安装(需联网),安装完成后请重新启动本程序。",
        )
        .title("缺少 WebView2 Runtime")
        .kind(MessageDialogKind::Warning)
        .blocking_show();
    if !accepted {
        eprintln!("[webview2] user declined to install WebView2; exiting.");
        return false;
    }
    if let Some(path) = bootstrapper {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            match std::process::Command::new(&path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
            {
                Ok(_) => {
                    eprintln!("[webview2] launched bootstrapper {:?}", path);
                    return true;
                }
                Err(e) => {
                    eprintln!("[webview2] failed to launch bootstrapper: {e}");
                    return false;
                }
            }
        }
        #[cfg(not(windows))]
        {
            match std::process::Command::new(&path).spawn() {
                Ok(_) => return true,
                Err(e) => {
                    eprintln!("[webview2] failed to launch bootstrapper: {e}");
                    return false;
                }
            }
        }
    }
    eprintln!("[webview2] bootstrapper not found in resources; cannot install.");
    false
}

fn bundled_bootstrapper_path(app: &AppHandle) -> Option<PathBuf> {
    // 1. Portable: exe parent (where the zip lays out the bootstrapper).
    if let Some(exe) = std::env::current_exe().ok() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("MicrosoftEdgeWebview2Setup.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    // 2. Installed: resource_dir.
    let dir = app.path().resource_dir().ok()?;
    let candidate = dir.join("MicrosoftEdgeWebview2Setup.exe");
    candidate.exists().then_some(candidate)
}
