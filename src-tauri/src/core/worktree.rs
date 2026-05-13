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

/// Phase 3.2: maximum time we'll wait for a remote `git clone` to finish.
/// Large monorepos over slow links can take a while; the existing
/// per-command 30 s budget in `ssh_run_for_worktree` is far too short.
const REMOTE_CLONE_TIMEOUT_SECS: u64 = 10 * 60;

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

/// Phase 3.2: structured result returned by `clone_repo_remote_ssh`. The
/// `default_branch` is whatever `git -C <dest> rev-parse --abbrev-ref HEAD`
/// reports immediately after the clone — usually `main` or `master`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteCloneResult {
    pub remote_path: String,
    pub default_branch: String,
}

/// Phase 3.2: validate user-supplied tokens against a tight allowlist so
/// nothing dangerous reaches the remote shell. `sh_quote` already prevents
/// argument breakout, but rejecting obvious sentinels here surfaces clearer
/// errors and gives defence-in-depth against future refactors that might
/// stop quoting somewhere downstream.
fn validate_clone_branch(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Branch name cannot start with '-'".to_string());
    }
    // Reject the usual shell + ref-format troublemakers. Spaces / control
    // chars / shell metacharacters / git's own forbidden ref tokens.
    for ch in name.chars() {
        if ch.is_control() {
            return Err("Branch name contains control characters".to_string());
        }
        if matches!(
            ch,
            ' ' | '\t'
                | '~'
                | '^'
                | ':'
                | '?'
                | '*'
                | '['
                | '\\'
                | '"'
                | '\''
                | '`'
                | '$'
                | ';'
                | '|'
                | '&'
                | '<'
                | '>'
                | '('
                | ')'
                | '{'
                | '}'
        ) {
            return Err(format!("Branch name contains invalid character '{}'", ch));
        }
    }
    if name.contains("..") || name.ends_with('/') || name.ends_with(".lock") {
        return Err("Branch name has invalid form".to_string());
    }
    Ok(())
}

fn validate_clone_dest_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Destination path cannot be empty".to_string());
    }
    if path.starts_with('-') {
        return Err("Destination path cannot start with '-'".to_string());
    }
    for ch in path.chars() {
        if ch.is_control() {
            return Err("Destination path contains control characters".to_string());
        }
        if matches!(ch, '\0' | '\n' | '\r' | '\'' | '"' | '`' | '$') {
            return Err(format!(
                "Destination path contains forbidden character '{}'",
                ch.escape_default()
            ));
        }
    }
    Ok(())
}

fn validate_clone_repo_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("Repository URL cannot be empty".to_string());
    }
    if url.starts_with('-') {
        return Err("Repository URL cannot start with '-'".to_string());
    }
    for ch in url.chars() {
        if ch.is_control() {
            return Err("Repository URL contains control characters".to_string());
        }
        if matches!(ch, '\0' | '\n' | '\r' | '\'' | '"' | '`' | '$') {
            return Err(format!(
                "Repository URL contains forbidden character '{}'",
                ch.escape_default()
            ));
        }
    }
    Ok(())
}

/// Phase 3.2: clone a remote repo into `dest_path` on the SSH host. Returns
/// the absolute path on the remote plus the freshly-cloned default branch.
///
/// Security:
/// - All arguments are POSIX single-quoted via `sh_quote`.
/// - Inputs go through allowlist validators (`validate_clone_*`) so the
///   model/UI cannot smuggle `-`-prefixed flags, control characters, or
///   shell metacharacters.
/// - `git clone -- <repo_url> <dest_path>` uses the `--` separator so the
///   positional args can never be re-interpreted as flags (e.g. an attacker
///   cannot inject `--upload-pack=<malicious>` even if the prefix check were
///   somehow bypassed).
/// - Timeout: 10 minutes (`REMOTE_CLONE_TIMEOUT_SECS`).
pub async fn clone_repo_remote_ssh(
    cfg: &SshConfig,
    repo_url: &str,
    dest_path: &str,
    branch: Option<&str>,
) -> Result<RemoteCloneResult, String> {
    validate_clone_repo_url(repo_url)?;
    validate_clone_dest_path(dest_path)?;
    if let Some(b) = branch {
        validate_clone_branch(b)?;
    }

    // Build: git clone [--branch <branch>] -- <repo_url> <dest_path>
    let mut argv: Vec<String> = vec!["clone".into()];
    if let Some(b) = branch {
        argv.push("--branch".into());
        argv.push(b.to_string());
    }
    argv.push("--".into());
    argv.push(repo_url.to_string());
    argv.push(dest_path.to_string());

    let quoted = argv
        .iter()
        .map(|a| sh_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = format!("git {}", quoted);

    info!(
        host = %cfg.host,
        dest = %dest_path,
        "Starting remote git clone (timeout {}s)",
        REMOTE_CLONE_TIMEOUT_SECS,
    );

    let output = crate::core::tool_runtime_ssh::ssh_run_with_timeout(
        cfg,
        &cmd,
        REMOTE_CLONE_TIMEOUT_SECS,
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "git clone failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            combined
        ));
    }

    // Resolve the default branch from the freshly-cloned repo so the
    // workspace knows what HEAD ended up on.
    let head_cmd = format!(
        "git -C {dest} rev-parse --abbrev-ref HEAD",
        dest = sh_quote(dest_path)
    );
    let head_out = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &head_cmd).await?;
    let default_branch = if head_out.status.success() {
        String::from_utf8_lossy(&head_out.stdout).trim().to_string()
    } else {
        // Non-fatal — clone itself succeeded. Fall back to whatever the
        // user asked for, or a conventional default.
        branch.map(str::to_string).unwrap_or_else(|| "main".into())
    };

    info!(
        host = %cfg.host,
        dest = %dest_path,
        branch = %default_branch,
        "Remote git clone succeeded",
    );
    Ok(RemoteCloneResult {
        remote_path: dest_path.to_string(),
        default_branch,
    })
}

/// Phase 3.3: classification of a remote path the dashboard might try to
/// inspect. Lets the frontend distinguish "host unreachable" from "path is
/// not a git repo" so it can show the right message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteRepoState {
    /// `<remote_path>/.git` (or equivalent) exists.
    GitRepo,
    /// SSH succeeded but the directory is not inside a git working tree.
    NotARepo,
}

/// Run `git -C <remote_path> rev-parse --is-inside-work-tree`. Returns the
/// classification, or an error if the SSH connection itself failed.
async fn ssh_classify_repo(
    cfg: &SshConfig,
    remote_path: &str,
) -> Result<RemoteRepoState, String> {
    let cmd = format!(
        "git -C {p} rev-parse --is-inside-work-tree 2>/dev/null",
        p = sh_quote(remote_path)
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.trim() == "true" {
            return Ok(RemoteRepoState::GitRepo);
        }
    }
    Ok(RemoteRepoState::NotARepo)
}

/// Phase 3.3: read `git status --short` on the remote and return the raw
/// porcelain output (no trailing newline). Frontend parses the same way it
/// parses the local `get_git_status` output.
pub async fn ssh_get_status(cfg: &SshConfig, remote_path: &str) -> Result<String, String> {
    match ssh_classify_repo(cfg, remote_path).await? {
        RemoteRepoState::NotARepo => {
            return Err(format!(
                "Remote path '{}' is not inside a git repository",
                remote_path
            ));
        }
        RemoteRepoState::GitRepo => {}
    }
    let cmd = format!(
        "git -C {p} status --short",
        p = sh_quote(remote_path)
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git status failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Phase 3.3: read the current branch (`rev-parse --abbrev-ref HEAD`) on
/// the remote.
pub async fn ssh_get_branch(cfg: &SshConfig, remote_path: &str) -> Result<String, String> {
    match ssh_classify_repo(cfg, remote_path).await? {
        RemoteRepoState::NotARepo => {
            return Err(format!(
                "Remote path '{}' is not inside a git repository",
                remote_path
            ));
        }
        RemoteRepoState::GitRepo => {}
    }
    let cmd = format!(
        "git -C {p} rev-parse --abbrev-ref HEAD",
        p = sh_quote(remote_path)
    );
    let output = crate::core::tool_runtime_ssh::ssh_run_for_worktree(cfg, &cmd).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "git rev-parse failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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

    // --- Phase 3.2 input validation ---

    #[test]
    fn validate_clone_branch_rejects_flag_injection() {
        assert!(validate_clone_branch("--upload-pack=evil").is_err());
        assert!(validate_clone_branch("-D").is_err());
    }

    #[test]
    fn validate_clone_branch_rejects_metacharacters() {
        assert!(validate_clone_branch("foo bar").is_err());
        assert!(validate_clone_branch("foo;rm -rf /").is_err());
        assert!(validate_clone_branch("foo`echo`").is_err());
        assert!(validate_clone_branch("foo$bar").is_err());
        assert!(validate_clone_branch("foo:bar").is_err());
    }

    #[test]
    fn validate_clone_branch_accepts_common_names() {
        assert!(validate_clone_branch("main").is_ok());
        assert!(validate_clone_branch("release/v1.2.3").is_ok());
        assert!(validate_clone_branch("feat-foo_bar").is_ok());
    }

    #[test]
    fn validate_clone_branch_rejects_empty() {
        assert!(validate_clone_branch("").is_err());
    }

    #[test]
    fn validate_clone_dest_path_rejects_flag_injection() {
        assert!(validate_clone_dest_path("--upload-pack=evil").is_err());
        assert!(validate_clone_dest_path("-o/etc").is_err());
    }

    #[test]
    fn validate_clone_dest_path_rejects_shell_meta() {
        assert!(validate_clone_dest_path("/tmp/foo`evil`").is_err());
        assert!(validate_clone_dest_path("/tmp/$(evil)").is_err());
        assert!(validate_clone_dest_path("/tmp/foo\nbar").is_err());
    }

    #[test]
    fn validate_clone_dest_path_accepts_unix_paths() {
        assert!(validate_clone_dest_path("/home/alice/proj").is_ok());
        assert!(validate_clone_dest_path("/var/www/site-1").is_ok());
    }

    #[test]
    fn validate_clone_repo_url_rejects_flag_injection() {
        assert!(validate_clone_repo_url("--upload-pack=evil").is_err());
    }

    #[test]
    fn validate_clone_repo_url_accepts_common_urls() {
        assert!(validate_clone_repo_url("git@github.com:foo/bar.git").is_ok());
        assert!(validate_clone_repo_url("https://github.com/foo/bar.git").is_ok());
        assert!(validate_clone_repo_url("ssh://git@host:22/foo/bar.git").is_ok());
    }

    #[test]
    fn validate_clone_repo_url_rejects_shell_meta() {
        assert!(validate_clone_repo_url("https://x.git'; rm -rf /;'").is_err());
        assert!(validate_clone_repo_url("https://x.git`evil`").is_err());
    }
}
