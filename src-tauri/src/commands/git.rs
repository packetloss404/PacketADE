use crate::core::execution::SshConfig;
use crate::core::git;
use crate::core::worktree::{self, RemoteCloneResult};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

#[tauri::command]
pub async fn get_git_branch(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_branch(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_git_status(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_status(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8.5: payload for the `issue-watcher:fixed` Tauri event. Emitted
/// after a successful commit whose message contains one or more
/// `Fixes #N` trailers that match a known Issue (looked up in
/// `PersistedState.issues` by the trailing numeric portion of
/// `ticket_id`). The frontend `issueStore` listener consumes this and
/// flips the matching Issue to `done`.
///
/// `commit_sha` is the short SHA (`rev-parse --short HEAD`) at the time
/// of the commit; `commit_subject` is the first line of the commit
/// message. Both are best-effort — if either probe fails the values
/// default to empty strings and the listener gracefully tolerates that.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueFixedPayload {
    pub issue_id: String,
    pub ticket_id: String,
    pub issue_number: u32,
    pub commit_sha: String,
    pub commit_subject: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitContextDto {
    #[serde(default)]
    pub flight_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

impl From<GitCommitContextDto> for git::GitCommitContext {
    fn from(value: GitCommitContextDto) -> Self {
        Self {
            flight_id: value.flight_id,
            task_id: value.task_id,
            attempt_id: value.attempt_id,
            conversation_id: value.conversation_id,
            session_id: value.session_id,
        }
    }
}

/// v0.8.5: extract `N` from every `Fixes #N` (case-insensitive) trailer
/// in a commit message. Accepts standalone lines like `Fixes #42`,
/// `fixes #42`, `Fixes: #42`, and a handful of conventional synonyms
/// (`Closes`, `Resolves`). De-duplicated, preserving first-seen order.
///
/// Conservative: only matches when the keyword starts at the beginning
/// of a line (allowing leading whitespace) so prose like "this commit
/// fixes #42 in the docs" doesn't accidentally close issues — only
/// real trailers do.
fn parse_fixes_trailers(msg: &str) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for raw_line in msg.lines() {
        let line = raw_line.trim_start();
        // Find the first whitespace, `:` or `#` after a leading keyword.
        // We match three keywords: fixes / closes / resolves. Anything
        // else is left alone.
        let lower = line.to_ascii_lowercase();
        let after_kw = if lower.starts_with("fixes") {
            Some(&line[5..])
        } else if lower.starts_with("closes") {
            Some(&line[6..])
        } else if lower.starts_with("resolves") {
            Some(&line[8..])
        } else {
            None
        };
        let Some(after) = after_kw else { continue };
        // After the keyword we expect: optional `:`, then whitespace,
        // then `#` and digits. Reject anything else so "fixesthebar"
        // doesn't false-positive.
        let after = after.trim_start_matches(':');
        let after = after.trim_start();
        let Some(rest) = after.strip_prefix('#') else {
            continue;
        };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            continue;
        }
        // Reject trailing junk like `#42foo` so we don't mis-parse a
        // hash followed by a word. `#42`, `#42.`, `#42,` are all fine.
        let after_digits = &rest[digits.len()..];
        if let Some(next) = after_digits.chars().next() {
            if next.is_alphanumeric() {
                continue;
            }
        }
        let Ok(n) = digits.parse::<u32>() else {
            continue;
        };
        if seen.insert(n) {
            out.push(n);
        }
    }
    out
}

/// v0.8.5: parse the trailing numeric portion of a `ticket_id` like
/// `PKT-001` → `1`. Returns `None` when the id doesn't end in digits.
/// The matching is purely numeric and ignores the prefix, so different
/// ticket prefixes (the user-configurable `ticketPrefix` in the issue
/// store, default `PKT`) all flow through the same close-loop.
fn ticket_number(ticket_id: &str) -> Option<u32> {
    let last_dash = ticket_id.rfind('-')?;
    ticket_id[last_dash + 1..].parse::<u32>().ok()
}

/// v0.8.5: after a successful commit, emit one `issue-watcher:fixed`
/// event per `Fixes #N` trailer that resolves to a known Issue (by
/// `ticket_id` suffix match). Failures are logged at warn but never
/// propagate — the commit itself already succeeded.
fn emit_fixes_events(app_handle: &AppHandle, project_path: &str, commit_msg: &str) {
    let numbers = parse_fixes_trailers(commit_msg);
    if numbers.is_empty() {
        return;
    }

    // Best-effort SHA + subject lookup. If git rev-parse fails (e.g.
    // detached state we can't recover) we still emit with empty
    // commit_sha so the listener flips the Issue without the audit
    // metadata.
    let commit_sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(project_path)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();

    let commit_subject = commit_msg.lines().next().unwrap_or("").trim().to_string();

    // Look up the issues persisted state. `load_state()` is sync I/O —
    // we're already on a `spawn_blocking` thread when called from
    // `git_commit`, so this is fine.
    let issues = crate::core::storage::load_state().issues;

    for number in numbers {
        let matched = issues
            .iter()
            .find(|i| ticket_number(&i.ticket_id) == Some(number));
        let Some(issue) = matched else {
            info!(
                number,
                "Fixes #N trailer found but no matching Issue in state"
            );
            continue;
        };
        if issue.status == "done" {
            info!(issue = %issue.id, number, "Issue already done, skipping watcher emit");
            continue;
        }
        let payload = IssueFixedPayload {
            issue_id: issue.id.clone(),
            ticket_id: issue.ticket_id.clone(),
            issue_number: number,
            commit_sha: commit_sha.clone(),
            commit_subject: commit_subject.clone(),
        };
        match app_handle.emit("issue-watcher:fixed", &payload) {
            Ok(_) => info!(
                issue = %issue.id,
                number,
                sha = %commit_sha,
                "Emitted issue-watcher:fixed",
            ),
            Err(e) => warn!(
                issue = %issue.id,
                error = %e,
                "Failed to emit issue-watcher:fixed event (non-fatal)",
            ),
        }
    }
}

/// P1-S4: read a file's committed `HEAD` content for the clickable
/// GitDashboard diff view. `Ok(None)` for untracked/new files or an
/// empty repo. See `git::get_file_head_content`.
#[tauri::command]
pub async fn get_file_head_content(
    project_path: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_file_head_content(&project_path, &rel_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_commit(
    app_handle: AppHandle,
    project_path: String,
    message: String,
    stage_all: bool,
    context: Option<GitCommitContextDto>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        super::validate_input_size(&message, super::MAX_INPUT_SIZE, "Commit message")?;
        let result =
            git::commit_with_context(&project_path, &message, stage_all, context.map(Into::into))?;

        // v0.8.5: scan the committed message (read back from HEAD so we
        // include any auto-trailers the prepare-commit-msg hook just
        // appended) for `Fixes #N` lines. This is the synchronous
        // close-loop trigger — external commits made directly via the
        // terminal won't flow through here, but the common in-app commit
        // path does.
        let final_msg = std::process::Command::new("git")
            .args(["log", "-1", "--pretty=%B"])
            .current_dir(&project_path)
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).into_owned())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| message.clone());

        emit_fixes_events(&app_handle, &project_path, &final_msg);

        Ok(result)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_push(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::push(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_pull(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::pull(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_create_branch(
    project_path: String,
    branch_name: String,
    checkout: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::create_branch(&project_path, &branch_name, checkout)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// P1-15: explicit `git add -- <paths>`. GitDashboard's per-file
/// staging control calls this before `git_commit` — `git_commit`
/// rejects `stage_all` commits, so this is the only way changes reach
/// the index through the in-app flow.
#[tauri::command]
pub async fn git_stage_files(project_path: String, paths: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        for p in &paths {
            super::validate_input_size(p, super::MAX_INPUT_SIZE, "File path")?;
        }
        git::stage_files(&project_path, &paths)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// P1-15: explicit `git restore --staged -- <paths>` — the unstage
/// counterpart of `git_stage_files`.
#[tauri::command]
pub async fn git_unstage_files(
    project_path: String,
    paths: Vec<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        for p in &paths {
            super::validate_input_size(p, super::MAX_INPUT_SIZE, "File path")?;
        }
        git::unstage_files(&project_path, &paths)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8-G: push a specific branch to `origin` with upstream tracking. Used
/// by the "Publish attempts as draft PRs" Flight option to push each
/// attempt's branch from inside its worktree before opening the draft PR.
/// `force=true` translates to `--force-with-lease` (safe force).
#[tauri::command]
pub async fn git_push_branch(
    project_path: String,
    branch_name: String,
    force: bool,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::push_branch(&project_path, &branch_name, force)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8-15: read `git remote get-url origin` so a new workspace can
/// auto-bind to its GitHub repo. Returns `Ok(None)` when the repo has
/// no `origin` remote configured (caller falls back to the manual
/// picker); `Err` only when the path is not a git repo or git itself
/// fails to spawn.
#[tauri::command]
pub async fn git_get_origin_url(project_path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::get_origin_url(&project_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn git_safety_check(project_path: String) -> Result<git::GitSafetyReport, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        Ok(git::safety_check(&project_path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// T3.F: provision a git worktree for an Agents-pane conversation. The
/// worktree lives at `<project_path>/.pkt-worktrees/<conv_id>` on a new
/// branch `pkt/<conv_id>` based off `base_branch`. Returns the absolute
/// worktree path so the frontend can pass it to `start_api_agent_session`
/// as the conversation's `project_path` — every subsequent tool call then
/// runs inside the worktree.
///
/// Idempotent: if the worktree already exists, returns its path.
#[tauri::command]
pub async fn create_conversation_worktree(
    project_path: String,
    conv_id: String,
    base_branch: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    worktree::create_local_worktree(&project_path, &conv_id, &base_branch).await
}

/// T3.F: tear down a worktree previously created by
/// `create_conversation_worktree`. Idempotent — missing worktrees succeed.
///
/// P2-S2: `delete_branch` (default false) additionally force-deletes the
/// `pkt/<conv_id>` branch after the worktree dir is removed. The Discard flow
/// passes true so a discarded conversation leaves no dangling branch behind.
#[tauri::command]
pub async fn remove_conversation_worktree(
    project_path: String,
    conv_id: String,
    delete_branch: Option<bool>,
) -> Result<(), String> {
    super::validate_project_path(&project_path)?;
    worktree::remove_local_worktree(&project_path, &conv_id, delete_branch.unwrap_or(false)).await
}

/// P2-S1: land a conversation's `pkt/<convId>` branch into the root
/// checkout by squash-merging (the default), with ruled safety semantics.
/// Gated on the same clean-root guard as `git_safety_check`: refuses on a
/// dirty root; on conflict it recovers so BOTH the root checkout and the
/// conversation worktree are left byte-identical; on success it creates the
/// squash commit, removes the worktree dir, and force-deletes the branch
/// (`-D` — a squash leaves no ancestry for `-d`). The returned outcome lets
/// the caller flip `worktree.state -> "landed"`. `squash` defaults to
/// `true` when omitted.
///
/// The dirty-root check deliberately excludes the `.pkt-worktrees/`
/// directory: an active conversation worktree always registers it as
/// untracked in the root, so a literal `git_safety_check` would refuse every
/// merge (see `core::git::merge_conversation_branch`).
#[tauri::command]
pub async fn merge_conversation_branch(
    project_path: String,
    branch: String,
    squash: Option<bool>,
) -> Result<git::MergeBranchOutcome, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        git::merge_conversation_branch(&project_path, &branch, squash.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// v0.8.5 fix: provision a git worktree bound to a specific Issue and
/// install the `prepare-commit-msg` hook that appends `Fixes #N` plus a
/// `Run-By: PacketADE issue I-<id>` trailer to every commit made inside
/// the worktree. The worktree lives at
/// `<project_path>/.pkt-worktrees/<issue_id>` on branch `pkt/<issue_id>`.
///
/// Returns the absolute worktree path so the frontend can use it as the
/// new workspace's `projectPath`, ensuring the PTY runs inside the
/// worktree (where the hook is installed) rather than the bare project
/// root. Without this, the auto-Done close-loop never fires — commits
/// in the bare repo carry no `Fixes #N` trailer, so `git_commit`'s
/// trailer scanner has nothing to match.
///
/// Base branch is auto-detected via the current `HEAD` of the project,
/// falling back to `HEAD` when the probe fails (matches the
/// `createConversationWorktree` caller in AgentsView).
///
/// Idempotent: if the worktree already exists, the hook is re-installed
/// and the existing path is returned.
#[tauri::command]
pub async fn create_issue_worktree(
    issue_id: String,
    issue_number: u32,
    issue_title: String,
    project_path: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;

    // Detect the base branch from the project's current HEAD. Falls
    // back to `HEAD` (a detached-style ref git can still branch off
    // of) if the probe fails — matches the conversation-worktree
    // caller's behaviour in AgentsView.
    let base_branch = {
        let pp = project_path.clone();
        tokio::task::spawn_blocking(move || git::get_branch(&pp))
            .await
            .map_err(|e| format!("Task join error: {}", e))?
            .ok()
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| "HEAD".to_string())
    };

    let issue = worktree::WorktreeIssue {
        issue_id: issue_id.clone(),
        issue_number,
        issue_title,
    };

    worktree::create_local_worktree_for_issue(&project_path, &issue_id, &base_branch, issue)
        .await
        .map_err(|e| format!("Issue worktree provision failed: {}", e))
}

/// Phase 3.3: minimum SSH config the remote git dashboard commands need.
/// The frontend builds this from a `Workspace.serverId` lookup against the
/// `serverStore`. Shared by `get_git_branch_remote`,
/// `get_git_status_remote`, and `clone_repo_remote`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitServerConfigDto {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub host_fingerprint: Option<String>,
}

impl GitServerConfigDto {
    fn into_ssh_config(self, remote_path: String) -> SshConfig {
        SshConfig {
            host: self.host,
            port: self.port,
            user: self.username,
            remote_path,
            key_path: self.key_path,
            auth_method: None,
            target_id: Some(self.id),
            host_fingerprint: self.host_fingerprint,
        }
    }
}

/// Phase 3.3: read the current branch on a remote SSH workspace. Mirrors
/// `get_git_branch` but routes through SSH using the saved
/// `ServerConfig`. Returns the same `String` shape so the frontend parser
/// can stay unchanged.
///
/// Errors:
/// - SSH connection failure → `"SSH ... failed: ..."` (verbatim from
///   `ssh_run`).
/// - Path not a git repo → `"Remote path '...' is not inside a git
///   repository"`.
#[tauri::command]
pub async fn get_git_branch_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_get_branch(&cfg, &remote_path).await
}

/// Phase 3.3: read `git status --short` on a remote SSH workspace. Output
/// is byte-identical to the local `get_git_status` command so the
/// frontend's `parseGitStatus` works without changes.
#[tauri::command]
pub async fn get_git_status_remote(
    server_config: GitServerConfigDto,
    remote_path: String,
) -> Result<String, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path cannot be empty".to_string());
    }
    let cfg = server_config.into_ssh_config(remote_path.clone());
    worktree::ssh_get_status(&cfg, &remote_path).await
}

/// Result returned to the frontend after a successful remote clone.
/// Mirrors `core::worktree::RemoteCloneResult` but lives here so the
/// `tauri::command` signature stays in the command layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRemoteResultDto {
    pub remote_path: String,
    pub default_branch: String,
}

impl From<RemoteCloneResult> for CloneRemoteResultDto {
    fn from(r: RemoteCloneResult) -> Self {
        Self {
            remote_path: r.remote_path,
            default_branch: r.default_branch,
        }
    }
}

/// Clone `repo_url` to `dest_path` on the SSH host described by
/// `server_config`. Behaviour & security guarantees live in
/// [`worktree::clone_repo_remote_ssh`]; this command is a thin wrapper
/// that turns the DTO into an `SshConfig`.
#[tauri::command]
pub async fn clone_repo_remote(
    server_id: String,
    server_config: GitServerConfigDto,
    repo_url: String,
    dest_path: String,
    branch: Option<String>,
) -> Result<CloneRemoteResultDto, String> {
    if !server_id.is_empty() && server_id != server_config.id {
        return Err(format!(
            "server_id '{}' does not match server_config.id '{}'",
            server_id, server_config.id
        ));
    }

    let cfg = server_config.into_ssh_config(dest_path.clone());
    let branch_ref = branch.as_deref();
    let result = worktree::clone_repo_remote_ssh(&cfg, &repo_url, &dest_path, branch_ref).await?;
    Ok(result.into())
}

// v0.8.5 — `Fixes #N` trailer parsing & ticket-id mapping tests. Kept
// alongside the parser so the canonical close-loop contract is locked
// down by the test suite.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fixes_trailers_matches_canonical_trailer() {
        let msg = "feat: add the thing\n\nFixes #42\nRun-By: PacketADE issue I-abc\n";
        assert_eq!(parse_fixes_trailers(msg), vec![42]);
    }

    #[test]
    fn parse_fixes_trailers_is_case_insensitive() {
        assert_eq!(parse_fixes_trailers("fixes #7"), vec![7]);
        assert_eq!(parse_fixes_trailers("FIXES #7"), vec![7]);
        assert_eq!(parse_fixes_trailers("Closes #7"), vec![7]);
        assert_eq!(parse_fixes_trailers("Resolves #7"), vec![7]);
    }

    #[test]
    fn parse_fixes_trailers_handles_colon_form() {
        // git-interpret-trailers tolerates both forms; we should too.
        assert_eq!(parse_fixes_trailers("Fixes: #99"), vec![99]);
    }

    #[test]
    fn parse_fixes_trailers_deduplicates() {
        let msg = "Fixes #1\nFixes #1\nFixes #2\n";
        assert_eq!(parse_fixes_trailers(msg), vec![1, 2]);
    }

    #[test]
    fn parse_fixes_trailers_ignores_prose_mentions() {
        // Conservative: only matches at start-of-line so a mention
        // inside the commit body doesn't false-positive.
        let msg = "feat: this also fixes #99 in the docs\n\nNo trailer here.";
        assert_eq!(parse_fixes_trailers(msg), Vec::<u32>::new());
    }

    #[test]
    fn parse_fixes_trailers_ignores_keyword_collisions() {
        // `fixesthebar` is not a trailer.
        assert_eq!(parse_fixes_trailers("fixesthebar #99"), Vec::<u32>::new());
        // `#42foo` is not a valid issue ref.
        assert_eq!(parse_fixes_trailers("Fixes #42foo"), Vec::<u32>::new());
    }

    #[test]
    fn parse_fixes_trailers_accepts_trailing_punctuation() {
        assert_eq!(parse_fixes_trailers("Fixes #42."), vec![42]);
        assert_eq!(parse_fixes_trailers("Fixes #42,"), vec![42]);
    }

    #[test]
    fn ticket_number_extracts_trailing_digits() {
        assert_eq!(ticket_number("PKT-001"), Some(1));
        assert_eq!(ticket_number("PKT-42"), Some(42));
        assert_eq!(ticket_number("ABC-007"), Some(7));
    }

    #[test]
    fn ticket_number_handles_custom_prefixes() {
        assert_eq!(ticket_number("CUSTOM-PREFIX-99"), Some(99));
    }

    #[test]
    fn ticket_number_rejects_non_numeric_tail() {
        assert_eq!(ticket_number("PKT-abc"), None);
        assert_eq!(ticket_number("PKT-"), None);
        assert_eq!(ticket_number("noprefix"), None);
    }
}
