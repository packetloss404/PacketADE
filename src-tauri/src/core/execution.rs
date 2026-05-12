//! Execution target for API-agent tool calls: local filesystem or a remote
//! host reached via the system `ssh` binary.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub remote_path: String,
    #[serde(default)]
    pub key_path: Option<String>,
    /// Frontend SshTarget id — used to look up the saved password in the
    /// OS keychain. None means key-only auth.
    #[serde(default)]
    pub target_id: Option<String>,
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
            "StrictHostKeyChecking=accept-new".into(),
            "-o".into(),
            "ConnectTimeout=10".into(),
        ];

        if cfg!(target_os = "windows") {
            // Windows OpenSSH lacks ControlMaster (no Unix domain sockets).
            // ServerAliveInterval keeps long-running commands healthy.
            args.push("-o".into());
            args.push("ServerAliveInterval=30".into());
        } else {
            let suffix = self.control_socket_suffix();
            args.push("-o".into());
            args.push("ControlMaster=auto".into());
            args.push("-o".into());
            args.push(format!("ControlPath=~/.ssh/.pkt-cm-{}.sock", suffix));
            args.push("-o".into());
            args.push("ControlPersist=10m".into());
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
            target_id: Some("target-abc".into()),
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
                .any(|a| a.starts_with("ControlPath=~/.ssh/.pkt-cm-")),
            "expected ControlPath with per-target socket in args: {:?}",
            args
        );
        assert!(
            args.iter().any(|a| a == "ControlPersist=10m"),
            "expected ControlPersist=10m in args: {:?}",
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
