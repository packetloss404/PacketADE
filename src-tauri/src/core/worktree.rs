//! Git worktree provisioning for async parallel agents.
//!
//! Each Attempt runs inside a dedicated git worktree on a branch named
//! `pkt/<attempt_id>`. Worktrees live under `<base>/.pkt-worktrees/<attempt_id>`.
//! Local worktrees use `tokio::process::Command::new("git")`. Remote worktrees
//! reuse `tool_runtime_ssh::ssh_run` so the existing keychain-password flow
//! applies automatically.

use crate::core::execution::{sh_quote, SshConfig};
use std::process::Stdio;
use tokio::process::Command;
use tracing::{info, warn};

const WORKTREES_DIR: &str = ".pkt-worktrees";

/// Branch name for an attempt. Stable + grep-friendly.
pub fn branch_name(attempt_id: &str) -> String {
    format!("pkt/{}", attempt_id)
}

/// Worktree path for an attempt, given its base path.
pub fn worktree_path(base: &str, attempt_id: &str) -> String {
    let trimmed = base.trim_end_matches(['/', '\\']);
    format!("{}/{}/{}", trimmed, WORKTREES_DIR, attempt_id)
}

// --- Local ---

async fn run_local_git(cwd: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn git: {}", e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code().unwrap_or(-1),
    ))
}

/// Create a local git worktree at `<base>/.pkt-worktrees/<attempt_id>` checked
/// out to a new branch `pkt/<attempt_id>` based on `base_branch`. Idempotent —
/// if the worktree already exists, returns its path without erroring.
pub async fn create_local_worktree(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id);
    let branch = branch_name(attempt_id);

    if std::path::Path::new(&path).exists() {
        info!(path = %path, "Worktree already exists, reusing");
        return Ok(path);
    }

    let (_, stderr, code) = run_local_git(
        base,
        &["worktree", "add", "-b", &branch, &path, base_branch],
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "git worktree add failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }
    info!(path = %path, branch = %branch, "Created local worktree");
    Ok(path)
}

/// Remove a local git worktree. Idempotent — missing worktree is not an error.
pub async fn remove_local_worktree(base: &str, attempt_id: &str) -> Result<(), String> {
    let path = worktree_path(base, attempt_id);
    if !std::path::Path::new(&path).exists() {
        return Ok(());
    }
    let (_, stderr, code) = run_local_git(base, &["worktree", "remove", "--force", &path]).await?;
    if code != 0 {
        warn!(path = %path, stderr = %stderr.trim(), "git worktree remove failed");
        return Err(format!(
            "git worktree remove failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }
    Ok(())
}

// --- Remote (SSH) ---

async fn ssh_git(cfg: &SshConfig, base: &str, args: &[&str]) -> Result<(String, i32), String> {
    let joined = args
        .iter()
        .map(|a| sh_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = format!("cd {} && git {}", sh_quote(base), joined);
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.is_empty() {
        stdout
    } else {
        format!("{}\n{}", stdout, stderr)
    };
    Ok((combined, output.status.code().unwrap_or(-1)))
}

/// Create a remote git worktree. Idempotent.
pub async fn create_remote_worktree(
    cfg: &SshConfig,
    base: &str,
    attempt_id: &str,
    base_branch: &str,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id);
    let branch = branch_name(attempt_id);

    let (_, code) = ssh_git(cfg, base, &["rev-parse", "--git-dir"]).await?;
    if code != 0 {
        return Err("Remote base path is not a git repo".to_string());
    }

    // Use `[ -d ... ]` to short-circuit if the worktree already exists.
    let check = format!("if [ -d {} ]; then echo EXISTS; fi", sh_quote(&path),);
    let existing = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &check).await?;
    if String::from_utf8_lossy(&existing.stdout).contains("EXISTS") {
        info!(path = %path, "Remote worktree already exists, reusing");
        return Ok(path);
    }

    let (combined, code) = ssh_git(
        cfg,
        base,
        &["worktree", "add", "-b", &branch, &path, base_branch],
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "remote git worktree add failed (exit {}): {}",
            code,
            combined.trim()
        ));
    }
    info!(path = %path, branch = %branch, "Created remote worktree");
    Ok(path)
}

/// Remove a remote git worktree. Idempotent.
pub async fn remove_remote_worktree(
    cfg: &SshConfig,
    base: &str,
    attempt_id: &str,
) -> Result<(), String> {
    let path = worktree_path(base, attempt_id);
    let (combined, code) = ssh_git(cfg, base, &["worktree", "remove", "--force", &path]).await?;
    if code != 0 && !combined.contains("not a working tree") {
        warn!(path = %path, output = %combined.trim(), "remote git worktree remove failed");
        return Err(format!(
            "remote git worktree remove failed (exit {}): {}",
            code,
            combined.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_path_strips_trailing_slashes() {
        assert_eq!(worktree_path("/repo", "a"), "/repo/.pkt-worktrees/a");
        assert_eq!(worktree_path("/repo/", "a"), "/repo/.pkt-worktrees/a");
        assert_eq!(worktree_path("/repo\\", "a"), "/repo/.pkt-worktrees/a");
    }

    #[test]
    fn branch_name_uses_pkt_prefix() {
        assert_eq!(branch_name("abc123"), "pkt/abc123");
    }

    #[test]
    fn worktree_path_handles_windows_base() {
        assert_eq!(
            worktree_path("D:\\projects\\demo", "att-1"),
            "D:\\projects\\demo/.pkt-worktrees/att-1"
        );
    }
}
