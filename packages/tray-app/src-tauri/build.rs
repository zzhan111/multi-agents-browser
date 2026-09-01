fn main() {
    // Inject the app version from the repo-root package.json so Rust code can
    // use `env!("BB_BROWSER_VERSION")`. package.json is the single source of
    // truth (the package script also syncs it into Cargo.toml/tauri.conf.json).
    inject_version();

    // Only invoke tauri-build when the tauri-app feature is active.
    // For pure-logic library tests, we skip it entirely.
    #[cfg(feature = "tauri-app")]
    tauri_build::build();
}

fn inject_version() {
    // build.rs runs with CWD = the crate dir (packages/tray-app/src-tauri).
    // The repo root is three levels up: src-tauri -> tray-app -> packages -> root.
    let manifest_path = std::path::Path::new("../../../package.json");
    let manifest = std::fs::read_to_string(manifest_path)
        .expect("build.rs: cannot read ../../../package.json — run from repo root");
    let version = extract_json_string_field(&manifest, "version")
        .expect("build.rs: package.json has no \"version\" string field");
    println!("cargo:rustc-env=BB_BROWSER_VERSION={}", version);
    // Re-run if package.json changes.
    println!("cargo:rerun-if-changed=../../../package.json");
}

/// Minimal JSON string-field extractor (avoids pulling a JSON crate into the
/// build script). Looks for `"version"` then the next quoted string.
fn extract_json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{}\"", field);
    let idx = json.find(&needle)?;
    let rest = &json[idx + needle.len()..];
    // Find the first `"` after the `:` that follows the field key.
    let colon = rest.find(':')?;
    let after_colon = &rest[colon + 1..];
    let quote = after_colon.find('"')?;
    let value_start_in_rest = colon + 1 + quote + 1;
    let value_rest = &rest[value_start_in_rest..];
    let end = value_rest.find('"')?;
    Some(value_rest[..end].to_string())
}
