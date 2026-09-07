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
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

const PLACEHOLDER: &str = "<APP_DIR>";
const SESSION_PLACEHOLDER: &str = "<SESSION_ID>";
const MCP_CONFIG_FILENAME: &str = "mcp-config.json";
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

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

/// Fill the `<APP_DIR>` and `<SESSION_ID>` placeholders in mcp-config.json
/// with the real portable root and an installation session. Idempotent after
/// the first run; the copy action below intentionally rotates the session so
/// two separately copied agent configs do not silently share one session.
pub fn fill_placeholders(app: &AppHandle) {
    let (Some(path), Some(dir)) = (config_path(app), app_dir()) else {
        return;
    };
    let Ok(mut text) = std::fs::read_to_string(&path) else {
        return;
    };
    if !text.contains(PLACEHOLDER) && !text.contains(SESSION_PLACEHOLDER) {
        return; // already filled
    }
    // JSON string values must escape backslashes, so double them when the
    // dir contains backslashes (Windows path separators).
    let dir_str = dir.to_string_lossy().replace('\\', "\\\\");
    text = text.replace(PLACEHOLDER, &dir_str);
    text = text.replace(SESSION_PLACEHOLDER, &new_session_id());
    let _ = std::fs::write(&path, text);
    eprintln!(
        "[mcp_config] filled <APP_DIR> -> {:?} in {}",
        dir,
        path.display()
    );
}

/// Return the filled `mcpServers` JSON object as a pretty-printed string, for
/// the "Copy MCP config" menu item. Each copy gets a new session id so a
/// second agent configured from the tray does not fall into the first agent's
/// session. Returns `None` if the file is missing or unparseable.
pub fn mcp_servers_json(app: &AppHandle) -> Option<String> {
    fill_placeholders(app);
    let path = config_path(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let mut root: Value = serde_json::from_str(&text).ok()?;
    let env = root
        .get_mut("mcpServers")?
        .get_mut("ma-browser")?
        .get_mut("env")?
        .as_object_mut()?;
    env.insert(
        "BB_SESSION_ID".to_string(),
        Value::String(new_session_id()),
    );
    let serialized = serde_json::to_string_pretty(&root).ok()?;
    std::fs::write(&path, format!("{serialized}\n")).ok()?;
    let servers = root.get("mcpServers")?;
    Some(serde_json::to_string_pretty(servers).ok()?)
}

/// Session ids are not credentials; they identify an agent's logical session
/// in the daemon. Use process + high-resolution time so no new runtime crate
/// is needed in the portable tray binary.
fn new_session_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let counter = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("tray-{:x}-{:x}-{:x}", std::process::id(), nanos, counter)
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
        assert_eq!(SESSION_PLACEHOLDER, "<SESSION_ID>");
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

    #[test]
    fn session_id_is_non_empty_and_not_a_placeholder() {
        let id = new_session_id();
        assert!(id.starts_with("tray-"));
        assert!(!id.contains(SESSION_PLACEHOLDER));
    }
}
