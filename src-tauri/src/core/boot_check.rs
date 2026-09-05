//! Boot-time configuration validation.
//!
//! PacketBench has no `.env` and almost no required configuration — most
//! settings are chosen in the UI and stored in the data dir or the OS
//! keyring. What CAN silently break a fresh install or a dark-period restart
//! is environmental: an unwritable data dir, a credential store that refuses
//! every read, a typo'd `PACKETBENCH_*` override, or a developer override that
//! points at a file that is no longer there. This module checks each once at
//! startup and logs one line per check under the `packetbench::boot` target,
//! naming the exact variable or path involved. It never aborts startup: the
//! app still opens so the user can read the message in the log or the UI.
//!
//! Log file: `%LOCALAPPDATA%\PacketBench\logs\packetbench.log.<date>` on
//! Windows, `~/Library/Application Support/PacketBench/logs/` on macOS,
//! `$XDG_DATA_HOME/PacketBench/logs/` on Linux (see `lib.rs::dirs_log_dir`).

use tracing::{info, warn};

/// Every `PACKETBENCH_*` variable the desktop binary (not the build scripts)
/// reads. Anything else with that prefix is almost certainly a typo.
const KNOWN_ENV_VARS: &[&str] = &[
    "PACKETBENCH_SIDECAR_PATH",
    "PACKETBENCH_NODE_PATH",
    "PACKETBENCH_DEV_SIDECAR",
    "PACKETBENCH_GITHUB_CLIENT_ID",
    "PACKETBENCH_REMOTE_NODE_PATH",
    "PACKETBENCH_REMOTE_SIDECAR_PATH",
    "PACKETBENCH_REMOTE_SIDECAR",
    "PACKETBENCH_REMOTE_SIDECAR_READY",
    "PACKETBENCH_ASKPASS_FILE",
    "PACKETBENCH_STATUSLINE_HELPER",
    "PACKETBENCH_STATUSLINE_DIR",
    "PACKETBENCH_OLLAMA_URL",
    "PACKETBENCH_OLLAMA_KEEP_ALIVE",
    "PACKETBENCH_OLLAMA_NUM_CTX_CAP",
    "PACKETBENCH_MINIMAX_URL",
    "PACKETBENCH_CUSTOM_COMPAT_URL",
    "PACKETBENCH_MCP_PROBE_TIMEOUT_MS",
];

/// Overrides whose value must name an existing file when set.
const FILE_PATH_ENV_VARS: &[&str] = &["PACKETBENCH_SIDECAR_PATH", "PACKETBENCH_NODE_PATH"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootIssue {
    pub check: &'static str,
    pub message: String,
}

/// Pure classification of the process environment; separated from `run` so
/// it is unit-testable without touching the real environment.
pub fn classify_env(vars: &[(String, String)], file_exists: &dyn Fn(&str) -> bool) -> Vec<BootIssue> {
    let mut issues = Vec::new();
    for (name, value) in vars {
        if !name.starts_with("PACKETBENCH_") {
            continue;
        }
        if !KNOWN_ENV_VARS.contains(&name.as_str()) {
            issues.push(BootIssue {
                check: "env",
                message: format!(
                    "{name} is set but is not a variable PacketBench reads (typo? known: {})",
                    KNOWN_ENV_VARS.join(", ")
                ),
            });
            continue;
        }
        if FILE_PATH_ENV_VARS.contains(&name.as_str()) && !file_exists(value) {
            issues.push(BootIssue {
                check: "env",
                message: format!("{name}={value} does not point at an existing file"),
            });
        }
    }
    issues
}

fn check_data_dir() -> Vec<BootIssue> {
    let dir = match crate::core::storage::ensure_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            return vec![BootIssue {
                check: "data_dir",
                message: format!("data dir cannot be created: {e}"),
            }]
        }
    };
    let probe = dir.join(".boot-write-probe");
    let result = std::fs::write(&probe, b"ok").and_then(|_| std::fs::remove_file(&probe));
    match result {
        Ok(()) => {
            info!(target: "packetbench::boot", check = "data_dir", path = %dir.display(), "data dir is writable");
            Vec::new()
        }
        Err(e) => vec![BootIssue {
            check: "data_dir",
            message: format!(
                "data dir {} is not writable ({e}); nothing will persist",
                dir.display()
            ),
        }],
    }
}

fn check_keyring() -> Vec<BootIssue> {
    match keyring::Entry::new(crate::core::brand::KEYRING_SERVICE, "boot-probe") {
        Ok(entry) => match entry.get_password() {
            Ok(_) | Err(keyring::Error::NoEntry) => {
                info!(target: "packetbench::boot", check = "keyring", service = crate::core::brand::KEYRING_SERVICE, "OS credential store is reachable");
                Vec::new()
            }
            Err(e) => vec![BootIssue {
                check: "keyring",
                message: format!(
                    "OS credential store failed a read ({e}); API keys, GitHub/Gitea tokens, and SSH passwords will be unreadable"
                ),
            }],
        },
        Err(e) => vec![BootIssue {
            check: "keyring",
            message: format!("OS credential store unavailable ({e})"),
        }],
    }
}

fn check_trust_file() -> Vec<BootIssue> {
    let path = crate::core::project_trust::trusted_projects_path();
    if path.is_file() {
        info!(target: "packetbench::boot", check = "trust", path = %path.display(), "trusted-projects file present");
    } else {
        info!(
            target: "packetbench::boot",
            check = "trust",
            path = %path.display(),
            "no trusted-projects file: repo-supplied hooks, .mcp.json servers, and .claude/agents are disabled for every project until one is created"
        );
    }
    Vec::new()
}

/// Run every check, log the outcome, and return the issues found.
pub fn run() -> Vec<BootIssue> {
    info!(
        target: "packetbench::boot",
        app = crate::core::brand::APP_NAME,
        version = env!("CARGO_PKG_VERSION"),
        debug_build = cfg!(debug_assertions),
        rust_log = %std::env::var("RUST_LOG").unwrap_or_else(|_| "<unset, default info>".to_string()),
        "boot check start"
    );
    let mut issues = Vec::new();
    issues.extend(check_data_dir());
    issues.extend(check_keyring());
    issues.extend(check_trust_file());
    let env: Vec<(String, String)> = std::env::vars().collect();
    issues.extend(classify_env(&env, &|p| std::path::Path::new(p).is_file()));
    for issue in &issues {
        warn!(target: "packetbench::boot", check = issue.check, "{}", issue.message);
    }
    info!(target: "packetbench::boot", issues = issues.len(), "boot check done");
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn unknown_prefixed_vars_are_flagged_as_typos() {
        let issues = classify_env(&vars(&[("PACKETBENCH_SIDECAR_PTH", "x")]), &|_| true);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("PACKETBENCH_SIDECAR_PTH"));
        assert!(issues[0].message.contains("typo"));
    }

    #[test]
    fn known_path_vars_must_exist() {
        let missing = classify_env(&vars(&[("PACKETBENCH_SIDECAR_PATH", "/nope/index.js")]), &|_| false);
        assert_eq!(missing.len(), 1);
        assert!(missing[0].message.contains("PACKETBENCH_SIDECAR_PATH=/nope/index.js"));
        let present = classify_env(&vars(&[("PACKETBENCH_SIDECAR_PATH", "/ok")]), &|_| true);
        assert!(present.is_empty());
    }

    #[test]
    fn unrelated_vars_are_ignored() {
        let issues = classify_env(&vars(&[("PATH", "x"), ("PACKETBENCH_DEV_SIDECAR", "1")]), &|_| false);
        assert!(issues.is_empty());
    }
}
