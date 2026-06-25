//! Pre-start WebView2 Runtime check.
//!
//! Tauri depends on WebView2 (pre-installed on Win11, may be absent on Win10).
//! When missing, Tauri fails ungracefully. This module checks the official
//! registry key and, if absent, prompts the user via a native dialog and
//! launches the bundled Evergreen Bootstrapper (MicrosoftEdgeWebview2Setup.exe
//! shipped as a Tauri resource alongside the exe).

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The WebView2 client registry value name (per Microsoft docs).
const WEBVIEW2_REG_KEY: &str =
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BFF-9B32BFE3D7A8}";
const WEBVIEW2_REG_VALUE: &str = "pv";

/// True if a WebView2 runtime is installed (any non-empty `pv` value).
pub fn is_installed() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let Ok(key) = hklm.open_subkey(WEBVIEW2_REG_KEY) else {
            return false;
        };
        let pv: Option<String> = key.get_value(WEBVIEW2_REG_VALUE).ok();
        matches!(pv, Some(v) if !v.is_empty())
    }
    #[cfg(not(windows))]
    {
        // non-Windows: no WebView2 concept; assume present.
        true
    }
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
    let dir = app.path().resource_dir().ok()?;
    let candidate = dir.join("MicrosoftEdgeWebview2Setup.exe");
    candidate.exists().then_some(candidate)
}
