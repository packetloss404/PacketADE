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
pub fn worktree_path(base: &str, attempt_id: &str) -> Result<String, String> {
    validate_worktree_component(attempt_id)?;
    let trimmed = base.trim_end_matches(['/', '\\']);
    Ok(format!("{}/{}/{}", trimmed, WORKTREES_DIR, attempt_id))
}

fn validate_worktree_component(component: &str) -> Result<(), String> {
    if component.is_empty() {
        return Err("Worktree id cannot be empty".to_string());
    }
    if std::path::Path::new(component).is_absolute() {
        return Err("Worktree id cannot be absolute".to_string());
    }
    if component == "." || component == ".." || component.contains("..") {
        return Err("Worktree id cannot contain traversal components".to_string());
    }
    if component.contains('/') || component.contains('\\') {
        return Err("Worktree id cannot contain path separators".to_string());
    }
    Ok(())
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

/// v0.8: optional mission context the worktree provisioner forwards to the
/// auto-trailer hook installer. When `None`, the trailer format's
/// `{flightId}` / `{flightTitle}` placeholders are filled with `"unknown"`
/// and `""` respectively. Used by callers that aren't mission-tied (e.g.
/// agents-pane conversation worktrees in `commands/git.rs`).
#[derive(Debug, Clone, Default)]
pub struct WorktreeMission {
    pub flight_id: Option<String>,
    pub flight_title: Option<String>,
}

/// v0.8.5: issue context the worktree provisioner forwards to the
/// auto-trailer hook installer for Issue-bound worktrees. The hook for
/// these worktrees writes two trailers:
///   `Fixes #{issue_number}`
///   `Run-By: PacketADE issue I-{issue_id}`
/// so that on commit the synchronous git_commit watcher can flip the
/// matching Issue to `done` via the `issue-watcher:fixed` event.
#[derive(Debug, Clone)]
pub struct WorktreeIssue {
    pub issue_id: String,
    pub issue_number: u32,
    pub issue_title: String,
}

/// Create a local git worktree at `<base>/.pkt-worktrees/<attempt_id>` checked
/// out to a new branch `pkt/<attempt_id>` based on `base_branch`. Idempotent —
/// if the worktree already exists, returns its path without erroring.
///
/// v0.8-16 (revised): conditionally installs a `prepare-commit-msg` hook
/// inside the worktree's `.git/hooks` directory so every commit made
/// inside the worktree gets a configurable trailer. The hook installer
/// reads `OrchestratorSettings.auto_commit_trailer_*` from the
/// persisted state and skips installation entirely when the user has
/// turned the feature off.
pub async fn create_local_worktree(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
) -> Result<String, String> {
    create_local_worktree_with_mission(base, attempt_id, base_branch, WorktreeMission::default())
        .await
}

/// v0.8: like `create_local_worktree` but accepts mission metadata so the
/// auto-trailer hook can substitute real values for `{flightId}` and
/// `{flightTitle}` placeholders.
pub async fn create_local_worktree_with_mission(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
    mission: WorktreeMission,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id)?;
    let branch = branch_name(attempt_id);

    if std::path::Path::new(&path).exists() {
        info!(path = %path, "Worktree already exists, reusing");
        // Idempotently re-install the hook so older worktrees pick it up
        // on next launch.
        if let Err(e) = install_prepare_commit_msg_hook(&path, attempt_id, &mission).await {
            warn!(path = %path, error = %e, "Failed to install prepare-commit-msg hook on existing worktree (non-fatal)");
        }
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

    // v0.8-16: auto-trailer hook. Non-fatal if it fails — the worktree
    // is still usable, the commit just won't carry the trailer.
    if let Err(e) = install_prepare_commit_msg_hook(&path, attempt_id, &mission).await {
        warn!(path = %path, error = %e, "Failed to install prepare-commit-msg hook (non-fatal)");
    }

    Ok(path)
}

/// v0.8.5: create a local git worktree dedicated to a specific Issue and
/// install a `prepare-commit-msg` hook that appends two trailers to every
/// commit made inside it:
///   `Fixes #{issue_number}`
///   `Run-By: PacketADE issue I-{issue_id}`
///
/// Mirrors `create_local_worktree_with_mission` but uses
/// `install_prepare_commit_msg_hook_for_issue` for the trailer logic.
/// Idempotent: existing worktrees re-receive the hook install on next
/// launch so older worktrees pick up the trailers.
///
/// Trailer installation respects `OrchestratorSettings.auto_commit_trailer_enabled`
/// — turning the toggle off skips hook installation entirely, matching
/// the mission-bound variant's behaviour.
pub async fn create_local_worktree_for_issue(
    base: &str,
    attempt_id: &str,
    base_branch: &str,
    issue: WorktreeIssue,
) -> Result<String, String> {
    let path = worktree_path(base, attempt_id)?;
    let branch = branch_name(attempt_id);

    if std::path::Path::new(&path).exists() {
        info!(path = %path, issue = %issue.issue_id, "Issue worktree already exists, reusing");
        if let Err(e) = install_prepare_commit_msg_hook_for_issue(&path, &issue).await {
            warn!(
                path = %path,
                issue = %issue.issue_id,
                error = %e,
                "Failed to install issue prepare-commit-msg hook on existing worktree (non-fatal)",
            );
        }
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
    info!(path = %path, branch = %branch, issue = %issue.issue_id, "Created local issue worktree");

    if let Err(e) = install_prepare_commit_msg_hook_for_issue(&path, &issue).await {
        warn!(
            path = %path,
            issue = %issue.issue_id,
            error = %e,
            "Failed to install issue prepare-commit-msg hook (non-fatal)",
        );
    }

    Ok(path)
}

/// v0.8: render the user-supplied trailer format with the live mission
/// values. Recognised placeholders: `{flightId}`, `{attemptId}`,
/// `{flightTitle}`. Anything else is passed through unchanged so users
/// can keep literal braces if they need to.
pub(crate) fn render_trailer_format(
    format: &str,
    flight_id: &str,
    attempt_id: &str,
    flight_title: &str,
) -> String {
    format
        .replace("{flightId}", flight_id)
        .replace("{attemptId}", attempt_id)
        .replace("{flightTitle}", flight_title)
}

/// v0.8: strip shell-meaningful characters out of trailer values before
/// they hit the hook script. The script writes them via a single-quoted
/// `printf` literal so quotes are the only real escape hazard, but we
/// also drop control characters / newlines so a malicious flight title
/// can't smuggle extra trailers in.
fn sanitize_trailer_value(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() || c == '\'' { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// v0.8-16 (revised): write a `prepare-commit-msg` hook inside the
/// worktree's git directory that appends the user-configured trailer to
/// every commit message that does not already carry one.
///
/// Behaviour driven by `OrchestratorSettings`:
/// - `auto_commit_trailer_enabled = false` → no hook is written; any
///   pre-existing hook from earlier runs is left alone.
/// - `auto_commit_trailer_format` → format string; placeholders
///   `{flightId}`, `{attemptId}`, `{flightTitle}` are substituted from
///   the supplied `mission` context. Unspecified placeholders fall back
///   to `"unknown"` / `""`.
///
/// Cross-platform notes:
/// - On POSIX, `chmod +x` is required for git to invoke the hook.
/// - On Windows with Git for Windows, the bundled MSYS shell honours
///   the `#!/bin/sh` shebang for hooks named `prepare-commit-msg`
///   (no extension), so the same script file works as-is. We make the
///   file executable on POSIX only.
///
/// The hook lives at `<worktree>/.git/hooks/prepare-commit-msg`.
/// Worktrees have a `.git` *file* (not directory) pointing at the main
/// repo's `worktrees/<id>` dir; we resolve it via `rev-parse
/// --git-path hooks` so both styles work.
async fn install_prepare_commit_msg_hook(
    worktree_path: &str,
    attempt_id: &str,
    mission: &WorktreeMission,
) -> Result<(), String> {
    // v0.8: consult the persisted orchestration settings. `load_state`
    // is sync; running it on a worker thread keeps us off the tokio
    // executor for the file I/O. Failures degrade to defaults — we'd
    // rather install the hook with the canonical format than skip
    // installation because a settings read hiccuped.
    let settings = tokio::task::spawn_blocking(|| crate::core::storage::load_state().settings)
        .await
        .map_err(|e| format!("settings load join error: {}", e))?;

    if !settings.auto_commit_trailer_enabled {
        info!(path = %worktree_path, "Auto-trailer disabled in settings; skipping hook install");
        return Ok(());
    }

    // Resolve the hooks dir for this worktree. `git rev-parse --git-path
    // hooks` returns the worktree-scoped hooks directory if it exists,
    // falling back to `.git/hooks`.
    let (stdout, _, code) =
        run_local_git(worktree_path, &["rev-parse", "--git-path", "hooks"]).await?;
    if code != 0 {
        return Err(format!(
            "git rev-parse --git-path hooks failed (exit {})",
            code
        ));
    }
    let rel = stdout.trim();
    if rel.is_empty() {
        return Err("git rev-parse returned empty hooks path".to_string());
    }
    // `rel` is relative to the worktree CWD. Join manually rather than
    // depending on `std::path::PathBuf::is_absolute` behaviour across
    // platforms.
    let hooks_dir = if std::path::Path::new(rel).is_absolute() {
        std::path::PathBuf::from(rel)
    } else {
        std::path::PathBuf::from(worktree_path).join(rel)
    };

    if let Err(e) = std::fs::create_dir_all(&hooks_dir) {
        return Err(format!("create_dir_all({:?}) failed: {}", hooks_dir, e));
    }

    let hook_path = hooks_dir.join("prepare-commit-msg");

    // Mission metadata: prefer explicit values from the caller, fall
    // back to the legacy worktree-grandparent-name heuristic for the
    // flight id, and finally to `"unknown"`. Title defaults to empty.
    let flight_id = mission
        .flight_id
        .as_deref()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::path::Path::new(worktree_path)
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        });
    let flight_title = mission.flight_title.as_deref().unwrap_or("");

    let flight_id_safe = sanitize_trailer_value(&flight_id);
    let attempt_id_safe = sanitize_trailer_value(attempt_id);
    let flight_title_safe = sanitize_trailer_value(flight_title);

    let trailer_line = render_trailer_format(
        &settings.auto_commit_trailer_format,
        &flight_id_safe,
        &attempt_id_safe,
        &flight_title_safe,
    );

    // Hook script. POSIX-sh; Git for Windows runs MSYS sh against the
    // shebang. Use a `case` rather than `grep -q` to keep the script
    // dependency-free. The trailer is injected into a single-quoted
    // `printf` arg so `$VAR` / backticks inside the trailer are
    // literal. We strip quotes from the trailer up front so the
    // single-quoted literal can't be broken out of.
    let script = format!(
        "#!/bin/sh\n\
         # PacketADE auto-trailer — appended to commits made inside this worktree.\n\
         # v0.8: installed by core/worktree.rs::install_prepare_commit_msg_hook.\n\
         FILE=\"$1\"\n\
         MSG=$(cat \"$FILE\")\n\
         case \"$MSG\" in\n\
           *\"Run-By: PacketADE\"*) exit 0 ;;\n\
         esac\n\
         printf '\\n%s\\n' '{trailer}' >> \"$FILE\"\n",
        trailer = trailer_line,
    );

    if let Err(e) = std::fs::write(&hook_path, script) {
        return Err(format!("write {:?} failed: {}", hook_path, e));
    }

    // POSIX: make executable. Windows: git's MSYS shell honours the
    // shebang directly, so the missing +x bit is fine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&hook_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            if let Err(e) = std::fs::set_permissions(&hook_path, perms) {
                warn!(path = ?hook_path, error = %e, "chmod +x on hook failed (non-fatal)");
            }
        }
    }
    // TODO(v0.8-16): consider also dropping a
    // `prepare-commit-msg.cmd` shim for environments where the MSYS sh
    // shim is missing from PATH. The native Git for Windows install
    // always ships it, so this is a low-priority follow-up.

    info!(
        path = ?hook_path,
        flight = %flight_id_safe,
        attempt = %attempt_id_safe,
        "Installed prepare-commit-msg auto-trailer hook",
    );
    Ok(())
}

/// v0.8.5: write a `prepare-commit-msg` hook inside an Issue-bound
/// worktree that appends two trailers to every commit message:
///
///   `Fixes #{issue_number}`
///   `Run-By: PacketADE issue I-{issue_id}`
///
/// Idempotent: if the commit message already contains either trailer
/// (e.g. the user typed `Fixes #N` themselves or a previous commit was
/// being amended), the hook detects it via a POSIX `case` match and
/// skips writing the duplicate. This means a user who manually wrote
/// `Fixes #42` will see exactly one `Fixes #42` line, not two.
///
/// Behaviour respects `OrchestratorSettings.auto_commit_trailer_enabled`
/// — turning the toggle off skips hook installation entirely. The
/// trailer format is fixed (not `auto_commit_trailer_format`) because
/// the v0.8.5 close-loop watcher needs to parse a stable `Fixes #N`
/// pattern; allowing arbitrary format strings would break the watcher.
async fn install_prepare_commit_msg_hook_for_issue(
    worktree_path: &str,
    issue: &WorktreeIssue,
) -> Result<(), String> {
    let settings = tokio::task::spawn_blocking(|| crate::core::storage::load_state().settings)
        .await
        .map_err(|e| format!("settings load join error: {}", e))?;

    if !settings.auto_commit_trailer_enabled {
        info!(path = %worktree_path, "Auto-trailer disabled in settings; skipping issue hook install");
        return Ok(());
    }

    let (stdout, _, code) =
        run_local_git(worktree_path, &["rev-parse", "--git-path", "hooks"]).await?;
    if code != 0 {
        return Err(format!(
            "git rev-parse --git-path hooks failed (exit {})",
            code
        ));
    }
    let rel = stdout.trim();
    if rel.is_empty() {
        return Err("git rev-parse returned empty hooks path".to_string());
    }
    let hooks_dir = if std::path::Path::new(rel).is_absolute() {
        std::path::PathBuf::from(rel)
    } else {
        std::path::PathBuf::from(worktree_path).join(rel)
    };

    if let Err(e) = std::fs::create_dir_all(&hooks_dir) {
        return Err(format!("create_dir_all({:?}) failed: {}", hooks_dir, e));
    }

    let hook_path = hooks_dir.join("prepare-commit-msg");

    let issue_id_safe = sanitize_trailer_value(&issue.issue_id);
    let issue_title_safe = sanitize_trailer_value(&issue.issue_title);
    let issue_number = issue.issue_number;

    let fixes_trailer = format!("Fixes #{}", issue_number);
    let run_by_trailer = format!("Run-By: PacketADE issue I-{}", issue_id_safe);

    // Hook script. Two idempotency checks via `case` glob:
    //   - skip the `Fixes #N` write if the message already contains it
    //     (word-boundary anchored via grep -E so `Fixes #4` doesn't match
    //     a pre-existing `Fixes #42`)
    //   - skip the `Run-By` write if any existing `Run-By: PacketADE` line
    //     is present (so amended commits don't stack lineage trailers)
    //
    // Single-quoted printf literals — `$` / backticks inside the
    // sanitized values are already neutralised by sanitize_trailer_value().
    let _title_unused = &issue_title_safe; // reserved for a future "Issue: <title>" comment line; not emitted today
    let script = format!(
        "#!/bin/sh\n\
         # PacketADE auto-trailer (issue v0.8.5) — appended to commits made inside this issue worktree.\n\
         FILE=\"$1\"\n\
         MSG=$(cat \"$FILE\")\n\
         if ! printf '%s' \"$MSG\" | grep -Eq '(^|[^0-9])Fixes #{number}([^0-9]|$)'; then\n\
           printf '\\n%s\\n' '{fixes}' >> \"$FILE\"\n\
         fi\n\
         case \"$MSG\" in\n\
           *\"Run-By: PacketADE\"*) ;;\n\
           *) printf '%s\\n' '{run_by}' >> \"$FILE\" ;;\n\
         esac\n",
        number = issue_number,
        fixes = fixes_trailer,
        run_by = run_by_trailer,
    );

    if let Err(e) = std::fs::write(&hook_path, script) {
        return Err(format!("write {:?} failed: {}", hook_path, e));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&hook_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            if let Err(e) = std::fs::set_permissions(&hook_path, perms) {
                warn!(path = ?hook_path, error = %e, "chmod +x on issue hook failed (non-fatal)");
            }
        }
    }

    info!(
        path = ?hook_path,
        issue = %issue_id_safe,
        number = issue_number,
        "Installed prepare-commit-msg auto-trailer hook (issue)",
    );
    Ok(())
}

/// Remove a local git worktree. Idempotent — missing worktree is not an error.
pub async fn remove_local_worktree(base: &str, attempt_id: &str) -> Result<(), String> {
    let path = worktree_path(base, attempt_id)?;
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
    let path = worktree_path(base, attempt_id)?;
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

    let output =
        crate::core::tool_runtime_ssh::ssh_run_with_timeout(cfg, &cmd, REMOTE_CLONE_TIMEOUT_SECS)
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
async fn ssh_classify_repo(cfg: &SshConfig, remote_path: &str) -> Result<RemoteRepoState, String> {
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
    let cmd = format!("git -C {p} status --short", p = sh_quote(remote_path));
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
    let path = worktree_path(base, attempt_id)?;
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
        assert_eq!(
            worktree_path("/repo", "a").unwrap(),
            "/repo/.pkt-worktrees/a"
        );
        assert_eq!(
            worktree_path("/repo/", "a").unwrap(),
            "/repo/.pkt-worktrees/a"
        );
        assert_eq!(
            worktree_path("/repo\\", "a").unwrap(),
            "/repo/.pkt-worktrees/a"
        );
    }

    #[test]
    fn branch_name_uses_pkt_prefix() {
        assert_eq!(branch_name("abc123"), "pkt/abc123");
    }

    #[test]
    fn worktree_path_handles_windows_base() {
        assert_eq!(
            worktree_path("D:\\projects\\demo", "att-1").unwrap(),
            "D:\\projects\\demo/.pkt-worktrees/att-1"
        );
    }

    #[test]
    fn worktree_component_rejects_path_escape() {
        for invalid in ["", ".", "..", "../x", "x/../y", "/tmp/x", "x/y", "x\\y"] {
            assert!(
                worktree_path("/repo", invalid).is_err(),
                "{invalid:?} should be rejected"
            );
        }
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

    // --- v0.8 auto-trailer format ---

    #[test]
    fn render_trailer_format_substitutes_known_placeholders() {
        assert_eq!(
            render_trailer_format(
                "Run-By: PacketADE mission F-{flightId} attempt A-{attemptId}",
                "abc",
                "att1",
                "Title",
            ),
            "Run-By: PacketADE mission F-abc attempt A-att1"
        );
    }

    #[test]
    fn render_trailer_format_substitutes_flight_title() {
        assert_eq!(
            render_trailer_format("[{flightTitle}] F-{flightId}", "abc", "att1", "Hello World"),
            "[Hello World] F-abc"
        );
    }

    #[test]
    fn render_trailer_format_passes_unknown_placeholders_through() {
        // Users keeping literal braces (e.g. for templating) should be
        // unaffected by the substitution pass.
        assert_eq!(
            render_trailer_format("custom {other} {flightId}", "abc", "att1", ""),
            "custom {other} abc"
        );
    }

    #[test]
    fn sanitize_trailer_value_strips_quotes_and_newlines() {
        assert_eq!(sanitize_trailer_value("foo'bar\nbaz"), "foo bar baz");
        assert_eq!(sanitize_trailer_value("  trimmed  "), "trimmed");
    }

    // --- v0.8.5 issue trailer ---

    #[test]
    fn worktree_issue_struct_holds_fields() {
        let wi = WorktreeIssue {
            issue_id: "abc123".to_string(),
            issue_number: 42,
            issue_title: "Fix the foo".to_string(),
        };
        assert_eq!(wi.issue_number, 42);
        assert_eq!(wi.issue_id, "abc123");
        assert_eq!(wi.issue_title, "Fix the foo");
    }

    #[test]
    fn sanitize_trailer_value_neutralises_quote_smuggling_attempts() {
        // The hook script wraps trailer values in single-quoted printf
        // literals; the sanitiser must strip both quote characters and
        // control bytes so an issue title can't smuggle extra trailer
        // lines into the commit message.
        let attack = "foo'\n\rRun-By: evil";
        let cleaned = sanitize_trailer_value(attack);
        assert!(
            !cleaned.contains('\''),
            "single-quote leaked: {:?}",
            cleaned
        );
        assert!(!cleaned.contains('\n'), "newline leaked: {:?}", cleaned);
        assert!(
            !cleaned.contains('\r'),
            "carriage return leaked: {:?}",
            cleaned
        );
    }
}
