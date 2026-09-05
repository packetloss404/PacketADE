//! Project trust: which repositories may supply code that PacketBench runs.
//!
//! Three repo-controlled files can cause PacketBench to execute something on
//! the user's machine the moment a conversation starts in that repo:
//!
//! - `<project>/.claude/settings.json` `hooks` — run through `sh -c` /
//!   `cmd /C` on SessionStart, PreToolUse, PostToolUse, SessionEnd
//!   (`core::hooks`).
//! - `<project>/.mcp.json` `mcpServers` — stdio servers spawned by the sidecar
//!   for Agent SDK sessions (`commands::api_agent::build_mcp_config_for_sidecar`).
//! - `<project>/.claude/agents/*.md` — sub-agent definitions whose prompt and
//!   tool list are advertised to the model (`commands::custom_agents`).
//!
//! None of those carried a trust decision: cloning an untrusted repository and
//! opening a conversation was enough. This module is the single fail-closed
//! gate. A project is trusted only when its canonical path is listed in
//! `<data dir>/trusted-projects.json`:
//!
//! ```json
//! { "version": 1, "projects": ["D:\\projects\\PacketBench", "/home/me/app"] }
//! ```
//!
//! Anything that cannot be read, parsed, or canonicalized is untrusted. There
//! is deliberately no environment-variable override: a repo-supplied shell
//! command is exactly the kind of thing an env var must not be able to enable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

pub const TRUSTED_PROJECTS_FILE: &str = "trusted-projects.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustedProjectsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    projects: Vec<String>,
}

/// Absolute path of the trust list. Lives beside `state.v1.json` so a
/// data-dir backup or restore carries the trust decisions with it.
pub fn trusted_projects_path() -> PathBuf {
    crate::core::storage::data_dir().join(TRUSTED_PROJECTS_FILE)
}

fn canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

fn read_trusted_projects(path: &Path) -> Vec<PathBuf> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            warn!(
                target: "packetbench::trust",
                path = %path.display(),
                error = %e,
                "trusted-projects file unreadable; treating every project as untrusted"
            );
            return Vec::new();
        }
    };
    let parsed: TrustedProjectsFile = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            warn!(
                target: "packetbench::trust",
                path = %path.display(),
                error = %e,
                "trusted-projects file is not valid JSON; treating every project as untrusted"
            );
            return Vec::new();
        }
    };
    if parsed.version != 1 {
        warn!(
            target: "packetbench::trust",
            path = %path.display(),
            version = parsed.version,
            "trusted-projects file has an unsupported version; expected 1"
        );
        return Vec::new();
    }
    parsed
        .projects
        .iter()
        .filter_map(|entry| {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                return None;
            }
            let path = Path::new(trimmed);
            if !path.is_absolute() {
                warn!(
                    target: "packetbench::trust",
                    entry = %trimmed,
                    "trusted-projects entry ignored: not an absolute path"
                );
                return None;
            }
            match canonical(path) {
                Some(canonical) => Some(canonical),
                None => {
                    warn!(
                        target: "packetbench::trust",
                        entry = %trimmed,
                        "trusted-projects entry ignored: path does not resolve"
                    );
                    None
                }
            }
        })
        .collect()
}

/// Pure decision: is `project_path` one of the trusted canonical roots?
/// Comparison is by canonical path so `D:\a\..\b` and a symlink to the same
/// directory count as the same project. A project inside a trusted root is
/// NOT trusted by inheritance — a repo cloned under a trusted parent is still
/// a different repo.
pub fn is_trusted_in(project_path: &str, trusted: &[PathBuf]) -> bool {
    if project_path.trim().is_empty() || trusted.is_empty() {
        return false;
    }
    let Some(canonical_project) = canonical(Path::new(project_path)) else {
        return false;
    };
    trusted.iter().any(|root| root == &canonical_project)
}

/// Whether repo-supplied executables (hooks, `.mcp.json` servers, project
/// agent definitions) may run for `project_path`. Fail-closed: any read,
/// parse, or canonicalization failure is `false`.
pub fn is_project_trusted(project_path: &str) -> bool {
    let path = trusted_projects_path();
    let trusted = read_trusted_projects(&path);
    let decision = is_trusted_in(project_path, &trusted);
    if !decision {
        info!(
            target: "packetbench::trust",
            project = %project_path,
            trust_file = %path.display(),
            "project is not trusted: repo-supplied hooks, .mcp.json servers, and .claude/agents are ignored"
        );
    }
    decision
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{}-trust-{}-{}",
            crate::core::brand::TEMP_DIR_PREFIX,
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_trusts_nothing() {
        let dir = temp_dir("missing");
        let project = dir.join("repo");
        std::fs::create_dir_all(&project).unwrap();
        let trusted = read_trusted_projects(&dir.join("nope.json"));
        assert!(trusted.is_empty());
        assert!(!is_trusted_in(project.to_str().unwrap(), &trusted));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_file_trusts_nothing() {
        let dir = temp_dir("malformed");
        let file = dir.join(TRUSTED_PROJECTS_FILE);
        std::fs::write(&file, "{ not json").unwrap();
        assert!(read_trusted_projects(&file).is_empty());
        std::fs::write(&file, r#"{"version": 2, "projects": ["/"]}"#).unwrap();
        assert!(
            read_trusted_projects(&file).is_empty(),
            "unknown version is untrusted"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn listed_project_is_trusted_and_siblings_are_not() {
        let dir = temp_dir("listed");
        let trusted_repo = dir.join("trusted");
        let other_repo = dir.join("other");
        let nested = trusted_repo.join("vendor").join("nested-repo");
        std::fs::create_dir_all(&trusted_repo).unwrap();
        std::fs::create_dir_all(&other_repo).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let file = dir.join(TRUSTED_PROJECTS_FILE);
        std::fs::write(
            &file,
            serde_json::to_string(&TrustedProjectsFile {
                version: 1,
                projects: vec![
                    trusted_repo.to_string_lossy().into_owned(),
                    "relative/path".to_string(),
                    "   ".to_string(),
                ],
            })
            .unwrap(),
        )
        .unwrap();
        let trusted = read_trusted_projects(&file);
        assert_eq!(trusted.len(), 1, "relative and blank entries are dropped");
        assert!(is_trusted_in(trusted_repo.to_str().unwrap(), &trusted));
        // A non-canonical spelling of the same directory still matches.
        let dotted = trusted_repo.join("vendor").join("..");
        assert!(is_trusted_in(dotted.to_str().unwrap(), &trusted));
        assert!(!is_trusted_in(other_repo.to_str().unwrap(), &trusted));
        assert!(
            !is_trusted_in(nested.to_str().unwrap(), &trusted),
            "trust is per repository, never inherited by a nested clone"
        );
        assert!(!is_trusted_in("", &trusted));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn end_to_end_reads_from_the_data_dir() {
        let dir = temp_dir("e2e");
        let _guard = crate::core::storage::redirect_data_dir_for_test(dir.clone());
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(!is_project_trusted(repo.to_str().unwrap()));
        std::fs::write(
            trusted_projects_path(),
            format!(
                r#"{{"version":1,"projects":[{}]}}"#,
                serde_json::to_string(repo.to_str().unwrap()).unwrap()
            ),
        )
        .unwrap();
        assert!(is_project_trusted(repo.to_str().unwrap()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
