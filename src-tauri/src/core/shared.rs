/// Windows CREATE_NO_WINDOW flag — prevents flashing console windows for background processes.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Apply platform-specific flags to hide console windows on Windows (no-op on other platforms).
#[cfg(windows)]
pub fn hide_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_window(_cmd: &mut std::process::Command) {}

/// Resolve the user's home directory (USERPROFILE on Windows, HOME on Unix).
pub fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
}

/// Lock a Mutex, converting PoisonError to a String.
pub fn lock_mutex<T>(mutex: &std::sync::Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|e| {
        tracing::error!("Mutex poisoned: {}", e);
        format!("Lock error: {}", e)
    })
}

/// True when a URL's host is one plaintext HTTP is acceptable for: loopback,
/// `localhost`, RFC 1918 / link-local / unique-local addresses, a single-label
/// hostname (no dot — LAN mDNS or hosts-file names), or a name under a
/// private suffix (`.local`, `.lan`, `.internal`, `.home.arpa`, `.localhost`).
/// Everything else is presumed to cross the public internet.
pub fn url_host_is_local(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => {
                let s = v6.segments();
                v6.is_loopback()
                    || (s[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                    || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                    || v6.to_ipv4_mapped().is_some_and(|v4| {
                        v4.is_loopback() || v4.is_private() || v4.is_link_local()
                    })
            }
        };
    }
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || !lower.contains('.') {
        return true;
    }
    [".local", ".lan", ".internal", ".home.arpa", ".localhost"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

/// Refuse a plaintext `http://` endpoint unless the host is local. Every
/// endpoint this guards carries a bearer secret (git-host PAT, MiniMax key,
/// custom-endpoint key), so a public `http://` URL would put that secret on
/// the wire in the clear. `what` names the setting in the error.
pub fn require_https_unless_local(url: &reqwest::Url, what: &str) -> Result<(), String> {
    match url.scheme() {
        "https" => Ok(()),
        "http" if url_host_is_local(url) => Ok(()),
        "http" => Err(format!(
            "{} must use https:// — plain http:// is only allowed for localhost, private-network, or .local/.lan/.internal hosts, because the credential would be sent in the clear.",
            what
        )),
        other => Err(format!("{} must use http:// or https:// (got {}://).", what, other)),
    }
}

/// Validate that a project path is a real, existing directory.
pub fn validate_project_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if path.is_empty() {
        return Err("Project path cannot be empty".to_string());
    }
    if !p.is_absolute() {
        return Err(format!("Project path must be absolute: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Project path is not a directory: {}", path));
    }
    Ok(())
}

/// Directories to always skip when traversing the file tree.
pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "coverage",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "vendor",
    "pkg",
    ".svelte-kit",
];

/// Maximum allowed size for PTY write payloads (64 KB).
pub const MAX_PTY_WRITE_SIZE: usize = 65_536;

/// Pick a heredoc terminator (with the given `prefix`) that does not appear in
/// `content`.
///
/// The suffix is seeded from OS randomness (`RandomState`, no RNG dependency)
/// so the terminator is not predictable from the payload — a crafted payload
/// cannot embed the terminator to break out of the heredoc — then the loop
/// guarantees the chosen terminator is absent from `content` so the heredoc
/// always closes correctly.
#[cfg(test)]
mod tls_guard_tests {
    use super::*;

    fn url(s: &str) -> reqwest::Url {
        reqwest::Url::parse(s).unwrap()
    }

    #[test]
    fn https_is_always_accepted() {
        assert!(require_https_unless_local(&url("https://api.minimax.io/v1"), "x").is_ok());
        assert!(require_https_unless_local(&url("https://git.example.com"), "x").is_ok());
    }

    #[test]
    fn plaintext_http_is_accepted_only_for_local_hosts() {
        for ok in [
            "http://localhost:8000/v1",
            "http://127.0.0.1:11434",
            "http://[::1]:8080",
            "http://10.0.0.5:3000",
            "http://172.16.4.4",
            "http://192.168.1.20/api",
            "http://169.254.1.1",
            "http://[fd00::1]",
            "http://[fe80::1]",
            "http://[::ffff:192.168.1.1]",
            "http://llm-box",
            "http://gitea.local",
            "http://nas.lan/gitea",
            "http://gw.internal",
            "http://box.home.arpa",
        ] {
            assert!(require_https_unless_local(&url(ok), "x").is_ok(), "{ok}");
        }
        for bad in [
            "http://api.minimax.io/v1",
            "http://gitea.example.com",
            "http://8.8.8.8",
            "http://[2606:4700:4700::1111]",
            "http://evil.com.local.example.com",
        ] {
            let err = require_https_unless_local(&url(bad), "Setting").unwrap_err();
            assert!(err.contains("Setting must use https://"), "{bad}: {err}");
        }
        assert!(require_https_unless_local(&url("ftp://x.local"), "x").is_err());
    }
}

pub fn pick_heredoc_terminator(content: &str, prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    // A fresh RandomState carries per-instance random keys; hashing empty input
    // yields a different value on every call.
    let mut suffix = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    loop {
        let candidate = format!("{prefix}{suffix:x}");
        if !content.contains(&candidate) {
            return candidate;
        }
        suffix = suffix.wrapping_mul(31).wrapping_add(7);
    }
}
