//! Execution target for API-agent tool calls: local filesystem or a remote
//! host reached via the system `ssh` binary.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::core::shared::home_dir;

/// Returns the app-managed `known_hosts` file path
/// (`<app_data_dir>/ssh/known_hosts`). Used to pin host keys explicitly
/// rather than accepting TOFU via `StrictHostKeyChecking=accept-new`.
pub fn app_known_hosts_path() -> PathBuf {
    let home = home_dir().unwrap_or_else(|| ".".to_string());
    PathBuf::from(home)
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("ssh")
        .join("known_hosts")
}

/// Ensure the parent directory of the known_hosts file exists. On Unix,
/// tighten permissions to 0700 so other local users cannot read or write.
pub fn ensure_known_hosts_dir() -> Result<PathBuf, String> {
    let path = app_known_hosts_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create known_hosts dir {:?}: {}", parent, e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    Ok(path)
}

/// Returns the app-managed ControlMaster socket directory
/// (`<app_data_dir>/ssh-cm/`). Created at startup with mode 0700 on Unix.
#[cfg(unix)]
pub fn app_controlmaster_dir() -> PathBuf {
    let home = home_dir().unwrap_or_else(|| ".".to_string());
    PathBuf::from(home)
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("ssh-cm")
}

/// Ensure the ControlMaster socket directory exists with mode 0700.
#[cfg(unix)]
pub fn ensure_controlmaster_dir() -> Result<PathBuf, String> {
    let dir = app_controlmaster_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ssh-cm dir {:?}: {}", dir, e))?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    Ok(dir)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub remote_path: String,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Frontend `ServerConfig.authMethod` when available (`agent`, `key`, or
    /// `password`). Older callers omit it; SSH helpers then fall back to
    /// password-keyring detection for compatibility.
    #[serde(default)]
    pub auth_method: Option<String>,
    /// Frontend `ServerConfig.id` — used to look up the saved password in
    /// the OS keychain (keyring entry: `ssh-<id>`). None means key-only
    /// auth. Phase 2 consolidated `SshTarget` into `ServerConfig`, so all
    /// new callers should pass `ServerConfig.id` here.
    #[serde(default)]
    pub target_id: Option<String>,
    /// SHA256 host-key fingerprint captured at first-connect. When present,
    /// SSH is invoked with `StrictHostKeyChecking=yes` + an app-managed
    /// `UserKnownHostsFile`. When `None`, falls back to legacy
    /// `accept-new` (TOFU) for backward compatibility with existing saved
    /// servers — a warning is logged so users can upgrade.
    #[serde(default)]
    pub host_fingerprint: Option<String>,
}

impl SshConfig {
    /// Build the argv prefix for invoking `ssh`. Returns args up to and
    /// including the `user@host` target; callers append the remote command.
    /// When `password_auth` is true, allow interactive auth so SSH will read
    /// the password from stdin.
    ///
    /// ControlMaster reuses a single SSH connection across multiple commands
    /// within ControlPersist seconds. First call pays full handshake; subsequent
    /// calls within 10 minutes are near-instant. This dramatically reduces
    /// per-tool-call latency for read/write/list/bash/grep operations against
    /// the same target. On Windows the OpenSSH client does NOT support
    /// ControlMaster (it requires Unix domain sockets), so we fall back to
    /// `ServerAliveInterval=30` only, which keeps long-running commands healthy
    /// but does not multiplex.
    pub fn ssh_args(&self, password_auth: bool) -> Vec<String> {
        let mut args = vec![
            "-p".into(),
            self.port.to_string(),
            "-o".into(),
            "ConnectTimeout=10".into(),
        ];

        // Host-key verification: prefer explicit pinning against an
        // app-managed known_hosts file. Legacy entries without a saved
        // fingerprint fall back to TOFU `accept-new` for one connection so
        // existing setups keep working — a warning is logged on the Rust
        // side, and the Servers UI prompts users to re-pin on next edit.
        if self.host_fingerprint.is_some() {
            let kh = app_known_hosts_path();
            args.push("-o".into());
            args.push("StrictHostKeyChecking=yes".into());
            args.push("-o".into());
            args.push(format!("UserKnownHostsFile={}", kh.to_string_lossy()));
        } else {
            tracing::warn!(
                host = %self.host,
                port = %self.port,
                "SSH target has no pinned host fingerprint — falling back to TOFU. Re-save the server to pin the key."
            );
            args.push("-o".into());
            args.push("StrictHostKeyChecking=accept-new".into());
        }

        #[cfg(target_os = "windows")]
        {
            // Windows OpenSSH lacks ControlMaster (no Unix domain sockets).
            // ServerAliveInterval keeps long-running commands healthy.
            args.push("-o".into());
            args.push("ServerAliveInterval=30".into());
        }
        #[cfg(unix)]
        {
            let suffix = self.control_socket_suffix();
            // Best-effort: create the socket dir with mode 0700. If this
            // fails we fall back to a per-target path inside HOME (legacy
            // behaviour) so the SSH call still succeeds.
            let socket_path = match ensure_controlmaster_dir() {
                Ok(dir) => dir
                    .join(format!("pkt-cm-{}.sock", suffix))
                    .to_string_lossy()
                    .to_string(),
                Err(e) => {
                    tracing::warn!(error = %e, "Falling back to ~/.ssh ControlMaster socket");
                    format!("~/.ssh/.pkt-cm-{}.sock", suffix)
                }
            };
            args.push("-o".into());
            args.push("ControlMaster=auto".into());
            args.push("-o".into());
            args.push(format!("ControlPath={}", socket_path));
            args.push("-o".into());
            // Reduced from 10m → 60s: shorter window of opportunity for a
            // local attacker to hijack the socket after disconnect.
            args.push("ControlPersist=60".into());
        }

        if password_auth {
            args.push("-o".into());
            args.push("NumberOfPasswordPrompts=1".into());
            args.push("-o".into());
            args.push("PreferredAuthentications=password,keyboard-interactive,publickey".into());
        } else {
            args.push("-o".into());
            args.push("BatchMode=yes".into());
        }
        if let Some(key) = self.key_path.as_ref() {
            if !key.trim().is_empty() {
                args.push("-i".into());
                args.push(key.clone());
            }
        }
        args.push(format!("{}@{}", self.user, self.host));
        args
    }

    /// Per-target unique suffix for the ControlMaster socket path. Prefers the
    /// frontend `target_id` (stable across restarts); otherwise hashes
    /// host+port+user so the same target still maps to the same socket.
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    fn control_socket_suffix(&self) -> String {
        if let Some(id) = self.target_id.as_ref() {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                return trimmed
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
            }
        }
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        self.host.hash(&mut hasher);
        self.port.hash(&mut hasher);
        self.user.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    }
}

#[derive(Debug, Clone)]
pub enum ExecutionTarget {
    Local { project_path: String },
    Ssh { config: SshConfig },
}

impl ExecutionTarget {
    /// Human-readable label used in logs and the system prompt.
    pub fn label(&self) -> String {
        match self {
            Self::Local { project_path } => project_path.clone(),
            Self::Ssh { config } => format!(
                "ssh://{}@{}:{}",
                config.user, config.host, config.remote_path
            ),
        }
    }
}

/// POSIX single-quote escape — safe to interpolate into a remote shell command.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolve `rel` against the configured remote workspace.
///
/// Remote tool paths must stay inside `base`: absolute paths and `..`
/// components are rejected instead of being passed through to the remote shell.
pub fn resolve_remote_path(base: &str, rel: &str) -> Result<String, String> {
    let base_trim = base.trim_end_matches('/');
    if base_trim.is_empty() {
        return Err("Remote workspace path is empty".to_string());
    }
    if rel.starts_with('/') {
        return Err("Remote tool paths must be relative to the workspace".to_string());
    }

    let mut parts = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err("Remote tool paths may not contain '..'".to_string());
            }
            _ if part.contains('\0') => {
                return Err("Remote tool paths may not contain NUL bytes".to_string());
            }
            _ => parts.push(part),
        }
    }

    if parts.is_empty() {
        Ok(base_trim.to_string())
    } else {
        Ok(format!("{}/{}", base_trim, parts.join("/")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cfg() -> SshConfig {
        SshConfig {
            host: "example.com".into(),
            port: 22,
            user: "alice".into(),
            remote_path: "/home/alice/project".into(),
            key_path: None,
            auth_method: Some("agent".into()),
            target_id: Some("target-abc".into()),
            host_fingerprint: None,
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_args_unix_includes_controlmaster() {
        let cfg = sample_cfg();
        let args = cfg.ssh_args(false);
        assert!(
            args.iter().any(|a| a == "ControlMaster=auto"),
            "expected ControlMaster=auto in args: {:?}",
            args
        );
        assert!(
            args.iter()
                .any(|a| a.starts_with("ControlPath=") && a.contains("pkt-cm-")),
            "expected ControlPath with per-target socket in args: {:?}",
            args
        );
        assert!(
            args.iter().any(|a| a == "ControlPersist=60"),
            "expected ControlPersist=60 in args: {:?}",
            args
        );
    }

    #[test]
    fn ssh_args_uses_pinned_known_hosts_when_fingerprint_set() {
        let mut cfg = sample_cfg();
        cfg.host_fingerprint = Some("SHA256:abc123".into());
        let args = cfg.ssh_args(false);
        assert!(
            args.iter().any(|a| a == "StrictHostKeyChecking=yes"),
            "expected pinned mode when fingerprint set: {:?}",
            args
        );
        assert!(
            args.iter().any(|a| a.starts_with("UserKnownHostsFile=")),
            "expected UserKnownHostsFile when fingerprint set: {:?}",
            args
        );
        assert!(
            !args.iter().any(|a| a == "StrictHostKeyChecking=accept-new"),
            "should not use accept-new when fingerprint set: {:?}",
            args
        );
    }

    #[test]
    fn ssh_args_falls_back_to_accept_new_when_unpinned() {
        let cfg = sample_cfg();
        let args = cfg.ssh_args(false);
        assert!(
            args.iter().any(|a| a == "StrictHostKeyChecking=accept-new"),
            "expected TOFU fallback when no fingerprint: {:?}",
            args
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ssh_args_windows_uses_serveralive_only() {
        let cfg = sample_cfg();
        let args = cfg.ssh_args(false);
        assert!(
            args.iter().any(|a| a == "ServerAliveInterval=30"),
            "expected ServerAliveInterval=30 in args: {:?}",
            args
        );
        assert!(
            !args.iter().any(|a| a == "ControlMaster=auto"),
            "Windows must not emit ControlMaster: {:?}",
            args
        );
    }

    #[test]
    fn control_socket_suffix_falls_back_to_hash_when_no_target_id() {
        let mut cfg = sample_cfg();
        cfg.target_id = None;
        let suffix = cfg.control_socket_suffix();
        assert!(!suffix.is_empty());
        // Same inputs should produce a stable suffix.
        assert_eq!(suffix, cfg.control_socket_suffix());
    }

    #[test]
    fn control_socket_suffix_sanitizes_target_id() {
        let mut cfg = sample_cfg();
        cfg.target_id = Some("weird/id with spaces".into());
        let suffix = cfg.control_socket_suffix();
        assert!(!suffix.contains('/'));
        assert!(!suffix.contains(' '));
    }

    #[test]
    fn resolve_remote_path_rejects_absolute_paths() {
        let err = resolve_remote_path("/home/alice/project", "/etc/passwd").unwrap_err();
        assert!(err.contains("relative"));
    }

    #[test]
    fn resolve_remote_path_rejects_parent_components() {
        let err = resolve_remote_path("/home/alice/project", "src/../../secret").unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn resolve_remote_path_keeps_relative_paths_under_base() {
        let path = resolve_remote_path("/home/alice/project/", "./src/main.rs").unwrap();
        assert_eq!(path, "/home/alice/project/src/main.rs");
    }
}
