//! Pure-logic semver parsing and comparison.
//!
//! Lives in the library crate (Tauri-free) so it can be unit-tested without
//! the GUI toolchain. Only handles clean `major.minor.patch` — no pre-release
//! tags (release tags are conventionally `vX.Y.Z`).

/// Parsed semantic version (major.minor.patch only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    /// Parse `"1.2.3"` or `"v1.2.3"` (strips a leading `v`). Returns `None`
    /// on any malformed input.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().strip_prefix('v').unwrap_or_else(|| s.trim());
        let mut parts = s.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch })
    }
}

/// True when `latest` is strictly newer than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (Version::parse(latest), Version::parse(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.major
            .cmp(&other.major)
            .then(self.minor.cmp(&other.minor))
            .then(self.patch.cmp(&other.patch))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_version() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!(v, Version { major: 1, minor: 2, patch: 3 });
    }

    #[test]
    fn strips_leading_v() {
        let v = Version::parse("v0.11.6").unwrap();
        assert_eq!(v, Version { major: 0, minor: 11, patch: 6 });
    }

    #[test]
    fn rejects_too_few_parts() {
        assert!(Version::parse("1.2").is_none());
    }

    #[test]
    fn rejects_too_many_parts() {
        assert!(Version::parse("1.2.3.4").is_none());
    }

    #[test]
    fn rejects_non_numeric() {
        assert!(Version::parse("1.2.x").is_none());
    }

    #[test]
    fn is_newer_true_for_higher_patch() {
        assert!(is_newer("1.2.4", "1.2.3"));
    }

    #[test]
    fn is_newer_true_for_higher_minor() {
        assert!(is_newer("1.3.0", "1.2.9"));
    }

    #[test]
    fn is_newer_false_for_equal() {
        assert!(!is_newer("1.2.3", "1.2.3"));
    }

    #[test]
    fn is_newer_false_for_lower() {
        assert!(!is_newer("1.2.2", "1.2.3"));
    }

    #[test]
    fn is_newer_handles_v_prefix_on_both() {
        assert!(is_newer("v0.12.0", "v0.11.6"));
    }

    #[test]
    fn is_newer_false_on_malformed() {
        assert!(!is_newer("garbage", "1.2.3"));
        assert!(!is_newer("1.2.3", "garbage"));
    }
}
