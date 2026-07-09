use super::shared::{hide_window, validate_project_path};
use std::process::Command;
use tracing::info;

fn status_lines(project_path: &str) -> Result<Vec<String>, String> {
    Ok(get_status(project_path)?
        .lines()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

fn worktree_is_clean(project_path: &str) -> Result<bool, String> {
    Ok(status_lines(project_path)?.is_empty())
}

fn has_staged_changes(project_path: &str) -> Result<bool, String> {
    Ok(status_lines(project_path)?.iter().any(|line| {
        if line.starts_with("??") {
            return false;
        }

        line.chars().next().map(|c| c != ' ').unwrap_or(false)
    }))
}

fn git_command(args: &[&str], cwd: &str) -> Result<std::process::Output, String> {
    validate_project_path(cwd)?;
    info!(command = ?args, cwd = %cwd, "Running git command");
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    hide_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    // Audit log
    let success = output.status.success();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if success {
        info!(command = ?args, cwd = %cwd, "Git command succeeded");
    } else {
        tracing::warn!(command = ?args, cwd = %cwd, stderr = %stderr, "Git command failed");
    }

    Ok(output)
}

fn git_command_result(args: &[&str], cwd: &str) -> Result<String, String> {
    let output = git_command(args, cwd)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {} failed", args[0])
        } else {
            stderr
        })
    }
}

/// A4: discover the git repo root containing `cwd`. Used by the
/// AGENTS.md cascading resolver to walk root → cwd. Returns `Err` when
/// `cwd` is not inside a git working tree (the caller falls back to
/// treating `cwd` as the only directory).
pub fn get_toplevel(cwd: &str) -> Result<String, String> {
    git_command_result(&["rev-parse", "--show-toplevel"], cwd)
}

/// v0.8-15: read the `origin` remote URL for `cwd`. Returns `Ok(None)`
/// when the repo has no `origin` remote (so the caller can fall back to
/// a manual GitHub repo selector). Returns `Err` only when `cwd` is not
/// a git repository or git itself fails.
pub fn get_origin_url(cwd: &str) -> Result<Option<String>, String> {
    let output = git_command(&["remote", "get-url", "origin"], cwd)?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if url.is_empty() {
            Ok(None)
        } else {
            Ok(Some(url))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // Git returns exit 2 with "No such remote 'origin'" when origin
        // isn't configured — treat that as Ok(None) so workspaces created
        // from non-GitHub repos don't error out.
        if stderr.contains("No such remote") || stderr.contains("no such remote") {
            return Ok(None);
        }
        Err(stderr.trim().to_string())
    }
}

/// v0.8-15: parse a GitHub remote URL into `(owner, repo)`. Accepts the
/// three forms git typically emits:
///   - `git@github.com:owner/repo.git`
///   - `https://github.com/owner/repo.git`
///   - `https://github.com/owner/repo`
/// Trailing `.git` is stripped. Anything that does not match a GitHub
/// host or lacks the `owner/repo` shape returns `None` so the caller
/// (workspace creation) silently skips auto-binding.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Locate the `host:path` boundary. SSH-style URLs use `:` as the
    // separator (`git@github.com:owner/repo.git`); HTTPS-style URLs use
    // `/` after the host.
    let after_host: &str = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("ssh://git@github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("git://github.com/") {
        rest
    } else {
        return None;
    };

    // Strip an optional `.git` suffix and any trailing slash.
    let stripped = after_host
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| after_host.trim_end_matches('/'));

    let mut parts = stripped.splitn(2, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    // Reject anything with further path segments (e.g. tree URLs).
    if repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

pub fn get_branch(project_path: &str) -> Result<String, String> {
    git_command_result(&["rev-parse", "--abbrev-ref", "HEAD"], project_path)
        .map_err(|_| "Not a git repository or git not found".to_string())
}

pub fn get_status(project_path: &str) -> Result<String, String> {
    let output = git_command(&["status", "--short"], project_path)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err("Failed to get git status".to_string())
    }
}

/// P1-S4 (clickable git rows): read a file's committed content at `HEAD`
/// so the frontend can diff it against the working-tree copy through the
/// shared DiffRows engine. Returns:
/// - `Ok(Some(content))` — the file exists in `HEAD` (content returned
///   verbatim, NO trimming, so the diff is byte-faithful);
/// - `Ok(None)` — the path is untracked / newly added, or the repo has no
///   commit yet (nothing to diff against → treat the whole file as added);
/// - `Err(..)` — any other git failure.
///
/// `rel_path` is repo-root-relative with forward slashes (as produced by
/// `git status --short`). Callers pass the NEW-side path for renames.
pub fn get_file_head_content(project_path: &str, rel_path: &str) -> Result<Option<String>, String> {
    let spec = format!("HEAD:{}", rel_path);
    let output = git_command(&["show", &spec], project_path)?;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    // Path not present in HEAD (untracked / newly added), or no HEAD yet
    // (fresh repo) — both mean "no prior content", i.e. a fully-added file.
    let no_prior = stderr.contains("does not exist")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("bad revision")
        || stderr.contains("unknown revision")
        || stderr.contains("invalid object name")
        || stderr.contains("ambiguous argument");
    if no_prior {
        Ok(None)
    } else {
        Err(stderr.trim().to_string())
    }
}

#[derive(Debug, Clone, Default)]
pub struct GitCommitContext {
    pub flight_id: Option<String>,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub conversation_id: Option<String>,
    pub session_id: Option<String>,
}

fn clean_trailer_value(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

pub fn append_packetade_context_trailers(message: &str, context: &GitCommitContext) -> String {
    let mut trailers: Vec<String> = Vec::new();
    if let Some(value) = context.flight_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketADE-Flight: {}", value));
    }
    if let Some(value) = context.task_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketADE-Task: {}", value));
    }
    if let Some(value) = context.attempt_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketADE-Attempt: {}", value));
    }
    if let Some(value) = context
        .conversation_id
        .as_deref()
        .and_then(clean_trailer_value)
    {
        trailers.push(format!("PacketADE-Conversation: {}", value));
    }
    if let Some(value) = context.session_id.as_deref().and_then(clean_trailer_value) {
        trailers.push(format!("PacketADE-Session: {}", value));
    }

    if trailers.is_empty() {
        return message.trim().to_string();
    }

    let mut out = message.trim_end().to_string();
    if !out.ends_with("\n\n") {
        if out.ends_with('\n') {
            out.push('\n');
        } else {
            out.push_str("\n\n");
        }
    }
    out.push_str(&trailers.join("\n"));
    out
}

pub fn commit(project_path: &str, message: &str, stage_all: bool) -> Result<String, String> {
    commit_with_context(project_path, message, stage_all, None)
}

pub fn commit_with_context(
    project_path: &str,
    message: &str,
    stage_all: bool,
    context: Option<GitCommitContext>,
) -> Result<String, String> {
    let trimmed_message = message.trim();
    if trimmed_message.is_empty() {
        return Err("Commit message is required".to_string());
    }

    if stage_all {
        return Err(
            "Stage-all commits are disabled in the in-app flow. Stage files explicitly first."
                .to_string(),
        );
    }

    if !has_staged_changes(project_path)? {
        return Err("No staged changes to commit. Stage files explicitly first.".to_string());
    }

    let final_message = context
        .as_ref()
        .map(|ctx| append_packetade_context_trailers(trimmed_message, ctx))
        .unwrap_or_else(|| trimmed_message.to_string());
    git_command_result(&["commit", "-m", &final_message], project_path)
}

/// P1-15: guard for individual file paths passed to `stage_files` /
/// `unstage_files`. Deliberately minimal — the `--` end-of-options
/// separator used below already prevents flag injection (a path like
/// `-weird` is passed through fine), and git itself rejects paths
/// outside the repo. We only reject inputs that can't possibly be a
/// real path: empty/whitespace-only strings and embedded NUL bytes
/// (which would truncate the arg when handed to the OS process API).
fn validate_stage_path(p: &str) -> Result<(), String> {
    if p.trim().is_empty() {
        return Err("File path cannot be empty".to_string());
    }
    if p.contains('\0') {
        return Err("File path contains invalid characters".to_string());
    }
    Ok(())
}

/// P1-15: explicit `git add -- <paths>` for the per-file staging UI.
/// GitDashboard's commit flow always stages specific files before
/// calling `commit_with_context` — `stage_all` commits are rejected
/// there, so this is the only path that puts changes in the index.
pub fn stage_files(project_path: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No files to stage".to_string());
    }
    for p in paths {
        validate_stage_path(p)?;
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command_result(&args, project_path)
}

/// P1-15: explicit `git restore --staged -- <paths>` — the unstage
/// counterpart of `stage_files`. Known limitation (not solved here):
/// `git restore --staged` fails on a repo with an unborn HEAD (no
/// commits yet); the resulting error surfaces in the dashboard's
/// feedback toast, which is acceptable for this slice.
pub fn unstage_files(project_path: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No files to unstage".to_string());
    }
    for p in paths {
        validate_stage_path(p)?;
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_command_result(&args, project_path)
}

pub fn push(project_path: &str) -> Result<String, String> {
    let branch = get_branch(project_path)?;
    if branch == "main" || branch == "master" {
        return Err(format!(
            "Refusing to push '{}' from the in-app toolbar. Use the terminal if you intend to push this protected branch.",
            branch
        ));
    }

    if !worktree_is_clean(project_path)? {
        return Err(
            "Cannot push with local changes present. Commit or stash them first.".to_string(),
        );
    }

    // Check upstream tracking
    let upstream = git_command_result(&["rev-parse", "--abbrev-ref", "@{upstream}"], project_path);
    if upstream.is_err() {
        // No upstream set — push with -u to set tracking
        return git_command_result(&["push", "-u", "origin", &branch], project_path);
    }

    // Check if behind upstream
    let behind = git_command_result(&["rev-list", "HEAD..@{upstream}", "--count"], project_path)
        .unwrap_or_default();
    if behind.trim() != "0" {
        return Err(format!(
            "Local branch is {} commit(s) behind upstream. Pull first.",
            behind.trim()
        ));
    }

    git_command_result(&["push"], project_path)
}

pub fn pull(project_path: &str) -> Result<String, String> {
    if !worktree_is_clean(project_path)? {
        return Err(
            "Cannot pull with local changes present. Commit, stash, or discard them first."
                .to_string(),
        );
    }

    git_command_result(&["pull", "--ff-only"], project_path)
}

pub fn create_branch(
    project_path: &str,
    branch_name: &str,
    checkout: bool,
) -> Result<String, String> {
    validate_branch_name(branch_name)?;
    if checkout {
        // NOTE: `git checkout -b -- <name>` is broken — git parses `--` as
        // the new branch name and `<name>` as the commit-ish to branch from
        // ("fatal: '<name>' is not a commit and a branch '--' cannot be
        // created from it"). `git branch -- <name>` works because branch
        // accepts `--` as end-of-options, but `checkout -b` does not. Flag
        // injection is already prevented by `validate_branch_name`
        // (rejects names starting with `-`).
        git_command_result(&["checkout", "-b", branch_name], project_path)
    } else {
        git_command_result(&["branch", "--", branch_name], project_path)
    }
}

/// v0.8-G: explicit-branch push for "Publish attempts as draft PRs". Unlike
/// `push`, this targets a specific branch by name (the attempt's worktree
/// branch), sets upstream tracking on first push, and intentionally
/// bypasses the main/master guard since attempt branches always live under
/// the `att_<uuid>` namespace. It still refuses if the worktree at
/// `project_path` is dirty — caller is expected to commit before publish.
pub fn push_branch(project_path: &str, branch_name: &str, force: bool) -> Result<String, String> {
    validate_branch_name(branch_name)?;
    if !worktree_is_clean(project_path)? {
        return Err(
            "Cannot push with local changes present. Commit or stash them first.".to_string(),
        );
    }
    let mut args: Vec<&str> = Vec::with_capacity(6);
    args.push("push");
    if force {
        args.push("--force-with-lease");
    }
    args.push("-u");
    args.push("origin");
    args.push(branch_name);
    git_command_result(&args, project_path)
}

fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('-') {
        return Err("Branch name cannot start with '-'".to_string());
    }
    if name.contains("..")
        || name.contains(' ')
        || name.contains('~')
        || name.contains('^')
        || name.contains(':')
        || name.contains('\\')
        || name.contains('\x7f')
        || name.contains('\0')
    {
        return Err("Branch name contains invalid characters".to_string());
    }
    if name.ends_with('/') || name.ends_with(".lock") || name.ends_with('.') {
        return Err("Branch name has an invalid suffix".to_string());
    }
    Ok(())
}

/// Pre-flight safety check for git state
#[derive(serde::Serialize)]
pub struct GitSafetyReport {
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub has_upstream: bool,
    pub is_clean: bool,
    pub uncommitted_count: usize,
    pub behind_upstream: usize,
    pub warnings: Vec<String>,
}

pub fn safety_check(project_path: &str) -> GitSafetyReport {
    let branch = get_branch(project_path).ok();
    let is_git_repo = branch.is_some();

    if !is_git_repo {
        return GitSafetyReport {
            is_git_repo: false,
            branch: None,
            has_upstream: false,
            is_clean: false,
            uncommitted_count: 0,
            behind_upstream: 0,
            warnings: vec!["Not a git repository".to_string()],
        };
    }

    let lines = status_lines(project_path).unwrap_or_default();
    let uncommitted_count = lines.len();
    let is_clean = uncommitted_count == 0;

    let has_upstream =
        git_command_result(&["rev-parse", "--abbrev-ref", "@{upstream}"], project_path).is_ok();

    let behind_upstream = if has_upstream {
        git_command_result(&["rev-list", "HEAD..@{upstream}", "--count"], project_path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    } else {
        0
    };

    let mut warnings = Vec::new();
    if !is_clean {
        warnings.push(format!("{} uncommitted change(s)", uncommitted_count));
    }
    if !has_upstream {
        warnings.push("No upstream tracking branch set".to_string());
    }
    if behind_upstream > 0 {
        warnings.push(format!("{} commit(s) behind upstream", behind_upstream));
    }
    if branch.as_deref() == Some("main") || branch.as_deref() == Some("master") {
        warnings.push("On protected branch — consider creating a feature branch".to_string());
    }

    GitSafetyReport {
        is_git_repo,
        branch,
        has_upstream,
        is_clean,
        uncommitted_count,
        behind_upstream,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Init a throwaway git repo in a unique temp dir with one committed
    /// file. Mirrors the tempdir convention used elsewhere (no extra
    /// dev-dependency). Returns the repo path.
    fn fixture_repo(tag: &str, rel: &str, committed: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetade-githead-{}-{}", tag, nanos));
        std::fs::create_dir_all(&dir).expect("create temp repo dir");
        let run = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("git run")
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "test@packetade.test"]);
        run(&["config", "user.name", "PacketADE Test"]);
        std::fs::write(dir.join(rel), committed).expect("write file");
        run(&["add", rel]);
        run(&["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn get_file_head_content_returns_committed_version_not_working_copy() {
        let repo = fixture_repo("committed", "foo.txt", "line1\n");
        let path = repo.to_string_lossy().to_string();
        // Dirty the working copy — HEAD content must still be the committed one.
        std::fs::write(repo.join("foo.txt"), "line1\nline2\n").unwrap();
        let head = get_file_head_content(&path, "foo.txt").expect("ok");
        assert_eq!(head, Some("line1\n".to_string()));
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn get_file_head_content_is_none_for_untracked_file() {
        let repo = fixture_repo("untracked", "foo.txt", "hi\n");
        let path = repo.to_string_lossy().to_string();
        std::fs::write(repo.join("new.txt"), "brand new\n").unwrap();
        let head = get_file_head_content(&path, "new.txt").expect("ok");
        assert_eq!(head, None);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn validate_branch_name_rejects_flag_injection() {
        assert!(validate_branch_name("--delete").is_err());
        assert!(validate_branch_name("-D").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_empty() {
        assert!(validate_branch_name("").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_double_dot() {
        assert!(validate_branch_name("foo..bar").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_bad_suffixes() {
        assert!(validate_branch_name("branch/").is_err());
        assert!(validate_branch_name("branch.lock").is_err());
        assert!(validate_branch_name("branch.").is_err());
    }

    #[test]
    fn validate_branch_name_rejects_special_chars() {
        assert!(validate_branch_name("feat ~thing").is_err());
        assert!(validate_branch_name("feat^thing").is_err());
        assert!(validate_branch_name("feat:thing").is_err());
        assert!(validate_branch_name("feat\\thing").is_err());
    }

    #[test]
    fn validate_branch_name_accepts_valid_names() {
        assert!(validate_branch_name("feature/foo").is_ok());
        assert!(validate_branch_name("fix-123").is_ok());
        assert!(validate_branch_name("release/v1.0.0").is_ok());
        assert!(validate_branch_name("my_branch").is_ok());
    }

    #[test]
    fn append_packetade_context_trailers_adds_flight_task_metadata() {
        let msg = append_packetade_context_trailers(
            "feat: land work",
            &GitCommitContext {
                flight_id: Some("flight-123".to_string()),
                task_id: Some("task-456".to_string()),
                ..GitCommitContext::default()
            },
        );
        assert!(msg.contains("PacketADE-Flight: flight-123"));
        assert!(msg.contains("PacketADE-Task: task-456"));
        assert!(msg.starts_with("feat: land work\n\n"));
    }

    #[test]
    fn append_packetade_context_trailers_sanitizes_control_chars() {
        let msg = append_packetade_context_trailers(
            "fix: thing\n",
            &GitCommitContext {
                conversation_id: Some("conv-1\nBAD".to_string()),
                ..GitCommitContext::default()
            },
        );
        assert!(msg.contains("PacketADE-Conversation: conv-1BAD"));
        assert!(!msg.contains("\nBAD"));
    }

    // v0.8-15 — workspace auto-bind helpers
    #[test]
    fn parse_github_remote_ssh_form() {
        assert_eq!(
            parse_github_remote("git@github.com:packetloss404/PacketADE.git"),
            Some(("packetloss404".to_string(), "PacketADE".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_https_with_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/foo/bar.git"),
            Some(("foo".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_https_without_git_suffix() {
        assert_eq!(
            parse_github_remote("https://github.com/foo/bar"),
            Some(("foo".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_trailing_slash() {
        assert_eq!(
            parse_github_remote("https://github.com/foo/bar/"),
            Some(("foo".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_github_remote_rejects_non_github_host() {
        assert_eq!(parse_github_remote("https://gitlab.com/foo/bar.git"), None);
        assert_eq!(parse_github_remote("git@gitlab.com:foo/bar.git"), None);
    }

    #[test]
    fn parse_github_remote_rejects_malformed() {
        assert_eq!(parse_github_remote(""), None);
        assert_eq!(parse_github_remote("not a url"), None);
        assert_eq!(parse_github_remote("https://github.com/just-owner"), None);
        assert_eq!(
            parse_github_remote("https://github.com/owner/repo/tree/main"),
            None
        );
    }

    // P1-15 — per-file staging path validation
    #[test]
    fn validate_stage_path_rejects_empty() {
        assert!(validate_stage_path("").is_err());
    }

    #[test]
    fn validate_stage_path_rejects_whitespace_only() {
        assert!(validate_stage_path("  ").is_err());
    }

    #[test]
    fn validate_stage_path_rejects_nul_byte() {
        assert!(validate_stage_path("a\0b").is_err());
    }

    #[test]
    fn validate_stage_path_accepts_normal_paths() {
        assert!(validate_stage_path("src/main.rs").is_ok());
        // Allowed because the `--` end-of-options separator in
        // `stage_files`/`unstage_files` prevents this from being
        // interpreted as a flag.
        assert!(validate_stage_path("-weird").is_ok());
    }
}
