//! GitHub-Releases-based update detection.
//!
//! Detects a newer release than the running build and exposes enough info
//! (latest version, release URL, asset download URL) for the tray menu to
//! surface a "🆕 有新版本 vX.Y.Z" item. There is NO auto-download/file-swap —
//! the user is guided to manually replace the portable zip (see spec §8).
//!
//! All network failures are silent (`check_latest` returns `None`) so an
//! unreachable GitHub never affects startup or the core daemon/Chrome path.

use ma_browser_tray::version::{is_newer, Version};
use serde::Deserialize;
use std::time::Duration;

/// GitHub repo that hosts releases (owner/name).
pub const RELEASE_REPO: &str = "zzhan111/multi-agents-browser";

/// Resolved info about a newer release.
#[derive(Debug, Clone)]
pub struct UpdateInfo {
    /// Latest version, e.g. "0.12.0" (no leading `v`).
    pub latest_version: String,
    /// Browser-facing release page URL.
    pub release_url: String,
    /// Direct download URL for the portable zip asset (first .zip asset).
    pub download_url: Option<String>,
}

/// Current app version, injected at build time from package.json.
pub fn current_version() -> &'static str {
    env!("BB_BROWSER_VERSION")
}

/// True when `latest` is strictly newer than the running build.
pub fn is_update_available(latest: &str) -> bool {
    is_newer(latest, current_version())
}

/// Fetch the latest release from GitHub. Returns `None` on ANY failure
/// (network, non-200, parse, rate-limit) — callers must treat this as
/// "feature unavailable", never an error.
pub async fn check_latest(repo: &str) -> Option<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{}/releases/latest", repo);
    let client = reqwest::Client::builder()
        .user_agent("ma-browser-tray-updater")
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: GithubRelease = resp.json().await.ok()?;
    // tag_name is conventionally "vX.Y.Z"; strip the leading `v`.
    let latest_version = body
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&body.tag_name)
        .to_string();
    // Validate it parses before reporting (a malformed tag is not an update).
    Version::parse(&latest_version)?;
    let download_url = body
        .assets
        .iter()
        .find(|a| a.name.ends_with(".zip"))
        .map(|a| a.browser_download_url.clone());
    Some(UpdateInfo {
        latest_version,
        release_url: body.html_url,
        download_url,
    })
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}
