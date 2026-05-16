pub mod agent;
pub mod agent_sidecar;
pub mod agents_md;
pub mod analytics;
pub mod api_agent;
pub mod api_keys;
pub mod auth_watcher;
pub mod checkpoints;
pub mod code_quality;
pub mod conversations;
pub mod crashes;
pub mod custom_agents;
pub mod deploy;
pub mod dictation;
pub mod error_classifier;
pub mod flight_attempts;
pub mod flight_chat;
pub mod fs;
pub mod git;
pub mod github;
pub mod history;
pub mod ideation;
pub mod insights;
// v0.8.5 — issues spec import.
pub mod issues;
pub mod mcp;
pub mod memory;
pub mod mission_planner;
pub mod mission_planner_compaction;
pub mod mission_planner_tools;
pub mod ollama;
pub mod orchestration;
pub mod pricing;
pub mod provider_auth;
pub mod provider_stats;
pub mod pty;
pub mod scaffold;
pub mod shared;
pub mod side_chat;
pub mod skills;
pub mod slash_commands;
pub mod spec;
pub mod ssh_keys;
pub mod state;
pub mod statusline;
pub mod usage;

use std::path::Path;

/// Validate that a project path is a real, existing directory.
pub fn validate_project_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
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

/// Check that a path does not escape above the given workspace root via `..` or symlinks.
pub fn is_within_workspace(path: &str, workspace: &str) -> Result<(), String> {
    let canonical_workspace = std::fs::canonicalize(workspace)
        .map_err(|e| format!("Cannot resolve workspace '{}': {}", workspace, e))?;
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;

    if !canonical_path.starts_with(&canonical_workspace) {
        return Err(format!(
            "Path '{}' is outside the workspace '{}'",
            path, workspace
        ));
    }
    Ok(())
}

/// Maximum allowed input size for text payloads (1 MB).
pub const MAX_INPUT_SIZE: usize = 1_000_000;

/// Maximum allowed size for PTY write payloads (64 KB).
pub const MAX_PTY_WRITE_SIZE: usize = 65_536;

/// Validate that an input string does not exceed the given size limit.
pub fn validate_input_size(input: &str, max_size: usize, field_name: &str) -> Result<(), String> {
    if input.len() > max_size {
        return Err(format!(
            "{} exceeds maximum size ({} bytes, limit {})",
            field_name,
            input.len(),
            max_size
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_project_path_rejects_empty() {
        let result = validate_project_path("");
        assert!(result.is_err());
    }

    #[test]
    fn validate_project_path_rejects_relative() {
        let result = validate_project_path("relative/path");
        assert!(result.is_err());
    }

    #[test]
    fn validate_input_size_accepts_within_limit() {
        let result = validate_input_size("hello", MAX_INPUT_SIZE, "test");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_input_size_rejects_over_limit() {
        let big = "x".repeat(MAX_INPUT_SIZE + 1);
        let result = validate_input_size(&big, MAX_INPUT_SIZE, "test");
        assert!(result.is_err());
    }

    #[test]
    fn validate_input_size_exact_limit_passes() {
        let exact = "x".repeat(MAX_INPUT_SIZE);
        let result = validate_input_size(&exact, MAX_INPUT_SIZE, "test");
        assert!(result.is_ok());
    }
}
