//! Machine-readable MCP access descriptor for coding agents.
//!
//! The portable zip ships a `mcp-config.json` template with a `<APP_DIR>`
//! placeholder (the extraction dir is unknown at packaging time). On first
//! startup the tray fills the placeholder with the actual exe-parent path
//! and writes it back, so a coding agent reading the file gets a
//! directly-usable `mcpServers` block (absolute command/args paths) with
//! `MA_BROWSER_CONNECT_ONLY=1` — the MCP server connects to the tray-owned
//! daemon instead of spawning its own.

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const PLACEHOLDER: &str = "<APP_DIR>";
const MCP_CONFIG_FILENAME: &str = "mcp-config.json";

/// Path to the bundled mcp-config.json. In a portable build this lives next
/// to the exe (current_exe().parent()); in an installed build it's under
/// resource_dir(). Prefer the exe-parent when it contains the file.
fn config_path(app: &AppHandle) -> Option<PathBuf> {
    // 1. Portable: exe parent.
    if let Some(exe) = std::env::current_exe().ok() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(MCP_CONFIG_FILENAME);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    // 2. Installed: resource_dir.
    let dir = app.path().resource_dir().ok()?;
    Some(dir.join(MCP_CONFIG_FILENAME))
}

/// The actual extraction root = parent of the running exe. This is where
/// `node/`, `mcp/`, `daemon/` live in a portable install.
fn app_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(|p| p.to_path_buf())
}

/// Fill the `<APP_DIR>` placeholder in mcp-config.json with the real path and
/// write it back. Idempotent: if already filled, this is a no-op. Silent on
/// any failure (the file may be absent in dev). Called at tray startup.
pub fn fill_placeholders(app: &AppHandle) {
    let (Some(path), Some(dir)) = (config_path(app), app_dir()) else {
        return;
    };
    let Ok(mut text) = std::fs::read_to_string(&path) else {
        return;
    };
    if !text.contains(PLACEHOLDER) {
        return; // already filled
    }
    // JSON string values must escape backslashes, so double them when the
    // dir contains backslashes (Windows path separators).
    let dir_str = dir.to_string_lossy().replace('\\', "\\\\");
    text = text.replace(PLACEHOLDER, &dir_str);
    let _ = std::fs::write(&path, text);
    eprintln!(
        "[mcp_config] filled <APP_DIR> -> {:?} in {}",
        dir,
        path.display()
    );
}

/// Return the filled `mcpServers` JSON object as a pretty-printed string, for
/// the "Copy MCP config" menu item. Returns `None` if the file is missing or
/// unparseable.
pub fn mcp_servers_json(app: &AppHandle) -> Option<String> {
    let path = config_path(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    let servers = root.get("mcpServers")?;
    Some(serde_json::to_string_pretty(servers).ok()?)
}

// ---------------------------------------------------------------------------
// Tests (pure helpers only; app/AppHandle paths are exercised in smoke test)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_constant_is_stable() {
        assert_eq!(PLACEHOLDER, "<APP_DIR>");
    }

    #[test]
    fn replace_preserves_json_escaping() {
        // When the dir contains backslashes, each must be escaped in JSON.
        let dir = "C:\\My Apps\\ma-browser-tray";
        let dir_escaped = dir.replace('\\', "\\\\");
        let template = r#"{"command":"<APP_DIR>\\node\\node.exe"}"#;
        let filled = template.replace(PLACEHOLDER, &dir_escaped);
        // The filled JSON must be valid JSON.
        let v: serde_json::Value = serde_json::from_str(&filled).unwrap();
        assert_eq!(
            v["command"],
            "C:\\My Apps\\ma-browser-tray\\node\\node.exe"
        );
    }
}
