//! `create_pull_request` tool for API-based agents.
//!
//! Lets an agent (typically a Flight Deck async attempt running inside a
//! `pkt/<id>` worktree branch) push the current branch and open a GitHub
//! pull request via the local or remote `gh` CLI.

use crate::core::execution::{sh_quote, ExecutionTarget};
use crate::core::llm_types::ToolDefinition;
use crate::core::tool_runtime_ssh;
use std::path::PathBuf;
use tracing::info;

/// Default base branch when the agent doesn't specify one.
const DEFAULT_BASE_BRANCH: &str = "main";

/// Timeout for the combined push + pr create flow (gh can be slow on cold
/// auth refresh).
const PR_TIMEOUT_SECS: u64 = 90;

/// JSON-Schema definition advertised to the provider.
pub fn create_pull_request_definition() -> ToolDefinition {
    ToolDefinition {
        name: "create_pull_request".to_string(),
        description: "Open a pull request from the current branch using the `gh` CLI. The current branch must already be pushed (this tool will push it for you if needed). Returns the PR URL.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Pull request title (single line)."
                },
                "body": {
                    "type": "string",
                    "description": "Pull request body in GitHub-flavored markdown."
                },
                "base": {
                    "type": "string",
                    "description": "Base branch to merge into. Defaults to 'main'."
                },
                "draft": {
                    "type": "boolean",
                    "description": "Open the PR in draft mode. Defaults to false."
                }
            },
            "required": ["title", "body"]
        }),
    }
}

/// Pluck a `https://github.com/.../pull/<n>` URL out of `gh` stdout.
fn extract_pr_url(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("https://github.com/") && trimmed.contains("/pull/") {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Build a unique-ish temp file name we can drop into the worktree for
/// `--body-file`. Worktree-local so we don't depend on platform tmpdirs.
fn temp_body_filename() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(".pkt-pr-body-{:x}.md", nanos)
}

/// Tool entry point. Dispatches to local or SSH execution.
pub async fn execute_create_pull_request(
    args: &serde_json::Value,
    target: &ExecutionTarget,
) -> Result<String, String> {
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'title' parameter")?
        .trim();
    if title.is_empty() {
        return Err("'title' must not be empty".to_string());
    }

    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'body' parameter")?;

    let base = args
        .get("base")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE_BRANCH);

    let draft = args.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);

    info!(title = %title, base = %base, draft = %draft, "Tool: create_pull_request");

    match target {
        ExecutionTarget::Local { project_path } => {
            run_local(project_path, title, body, base, draft).await
        }
        ExecutionTarget::Ssh { config } => run_ssh(config, title, body, base, draft).await,
    }
}

// -- Local execution --------------------------------------------------------

async fn run_local(
    project_path: &str,
    title: &str,
    body: &str,
    base: &str,
    draft: bool,
) -> Result<String, String> {
    // Drop the body in a temp file inside the worktree so we don't have to
    // shell-escape multi-line markdown.
    let body_filename = temp_body_filename();
    let body_path: PathBuf = PathBuf::from(project_path).join(&body_filename);

    std::fs::write(&body_path, body)
        .map_err(|e| format!("Failed to write PR body temp file: {}", e))?;

    // Stage 1: push the current branch.
    let push_out = run_local_cmd(
        project_path,
        &["git", "push", "-u", "origin", "HEAD"],
        PR_TIMEOUT_SECS,
    )
    .await;

    if let Err(e) = push_out {
        let _ = std::fs::remove_file(&body_path);
        return Err(format!("git push failed: {}", e));
    }
    let push_out = push_out.unwrap();
    if !push_out.status.success() {
        let _ = std::fs::remove_file(&body_path);
        let stderr = String::from_utf8_lossy(&push_out.stderr);
        return Err(format!(
            "git push failed (exit {}): {}",
            push_out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    // Stage 2: gh pr create.
    let mut gh_args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        title.to_string(),
        "--body-file".into(),
        body_filename.clone(),
        "--base".into(),
        base.to_string(),
    ];
    if draft {
        gh_args.push("--draft".into());
    }

    let gh_argv: Vec<&str> = std::iter::once("gh")
        .chain(gh_args.iter().map(|s| s.as_str()))
        .collect();

    let result = run_local_cmd(project_path, &gh_argv, PR_TIMEOUT_SECS).await;
    let _ = std::fs::remove_file(&body_path);

    let output = result.map_err(|e| format!("gh pr create failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "gh pr create failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    if let Some(url) = extract_pr_url(&stdout) {
        Ok(url)
    } else {
        let combined = if stderr.trim().is_empty() {
            stdout
        } else {
            format!("{}\n--- stderr ---\n{}", stdout, stderr)
        };
        Ok(combined.trim().to_string())
    }
}

async fn run_local_cmd(
    cwd: &str,
    argv: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    if argv.is_empty() {
        return Err("Empty command".to_string());
    }
    let mut cmd = tokio::process::Command::new(argv[0]);
    if argv.len() > 1 {
        cmd.args(&argv[1..]);
    }
    cmd.current_dir(cwd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Reap the child if we bail out on the timeout below instead of leaving it
    // running; dropping the `Child` then terminates the OS process.
    cmd.kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", argv[0], e))?;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Command '{}' timed out after {}s", argv[0], timeout_secs))?
    .map_err(|e| format!("Command '{}' failed: {}", argv[0], e))?;

    Ok(output)
}

// -- SSH execution ----------------------------------------------------------

async fn run_ssh(
    config: &crate::core::execution::SshConfig,
    title: &str,
    body: &str,
    base: &str,
    draft: bool,
) -> Result<String, String> {
    // Use mktemp on the remote so we don't have to invent unique names; gh
    // will read the body from there. We `cd` to the worktree first so push
    // and gh both see the right branch / repo.
    let draft_flag = if draft { " --draft" } else { "" };

    // We embed the body via a single-quoted heredoc to avoid having to
    // escape user markdown. The body is written to the temp file, push
    // happens, gh runs, the temp file is removed unconditionally.
    let eof = pick_heredoc_terminator(body);

    let script = format!(
        "set -e\n\
         cd {cwd}\n\
         tmp=$(mktemp -t pkt-pr-body.XXXXXX) || exit 90\n\
         trap 'rm -f \"$tmp\"' EXIT\n\
         cat > \"$tmp\" <<'{eof}'\n\
         {body}\n\
         {eof}\n\
         git push -u origin HEAD 1>&2\n\
         gh pr create --title {title_q} --body-file \"$tmp\" --base {base_q}{draft}\n",
        cwd = sh_quote(&config.remote_path),
        eof = eof,
        body = body,
        title_q = sh_quote(title),
        base_q = sh_quote(base),
        draft = draft_flag,
    );

    let output = tool_runtime_ssh::ssh_run_for_worktree(config, &script).await?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "gh pr create failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    if let Some(url) = extract_pr_url(&stdout) {
        return Ok(url);
    }
    // Fallback: gh sometimes prints the URL on stderr, especially when push
    // chatter is interleaved. Try stderr too.
    if let Some(url) = extract_pr_url(&stderr) {
        return Ok(url);
    }

    let combined = if stderr.trim().is_empty() {
        stdout
    } else {
        format!("{}\n--- stderr ---\n{}", stdout, stderr)
    };
    Ok(combined.trim().to_string())
}

/// Local copy of the heredoc-terminator picker (kept private to this module
/// so we don't need to widen `tool_runtime_ssh`'s public surface).
fn pick_heredoc_terminator(content: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    loop {
        let candidate = format!("PACKETCODE_PR_EOF_{:x}", suffix);
        if !content.contains(&candidate) {
            return candidate;
        }
        suffix = suffix.wrapping_mul(31).wrapping_add(7);
    }
}
