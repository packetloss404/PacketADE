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
    pub fn ssh_args(&self, password_auth: bool) -> Vec<String> {
        let mut args = vec![
            "-p".into(),
            self.port.to_string(),
            "-o".into(),
            "StrictHostKeyChecking=accept-new".into(),
            "-o".into(),
            "ConnectTimeout=10".into(),
        ];
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

/// Resolve `rel` against the remote base path. Absolute paths pass through;
/// `.` and empty map to the base; otherwise join with `/`.
pub fn resolve_remote_path(base: &str, rel: &str) -> String {
    if rel.starts_with('/') {
        rel.to_string()
    } else if rel == "." || rel.is_empty() {
        base.trim_end_matches('/').to_string()
    } else {
        let base_trim = base.trim_end_matches('/');
        format!("{}/{}", base_trim, rel)
    }
}
