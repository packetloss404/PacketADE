//! Claude-Code-style hooks system.
//!
//! Hooks live in `<home>/.claude/settings.json` (and project
//! `.claude/settings.json`) under a `"hooks"` array. Each entry is a
//! lifecycle command that runs on a specific event:
//!
//! ```json
//! {
//!   "hooks": [
//!     { "event": "PreToolUse", "matcher": "Bash(git push:*)", "command": "echo blocked" },
//!     { "event": "SessionEnd", "command": "notify-send 'session done'" }
//!   ]
//! }
//! ```
//!
//! - `event` — one of `SessionStart | PreToolUse | PostToolUse | SessionEnd | UserPromptSubmit`.
//! - `matcher` — optional. When present, the hook only runs for tool calls
//!   whose name (or, for Bash, command prefix) matches the pattern.
//! - `command` — shell command. Run via `sh -c` on Unix, `cmd /C` on Windows.
//!   The hook's stdin receives the JSON payload (tool name, args, etc).
//!
//! Semantics for `PreToolUse`: a non-zero exit code vetoes the tool call.
//! Other events are best-effort — failures are logged and ignored.
//!
//! See `core/hooks.rs` and `commands/api_agent.rs::run_agent_loop` for the
//! integration points.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::{debug, warn};

use super::shared::home_dir;

/// Lifecycle events at which hooks fire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEvent {
    SessionStart,
    PreToolUse,
    PostToolUse,
    SessionEnd,
    UserPromptSubmit,
}

impl HookEvent {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "SessionStart" => Some(Self::SessionStart),
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            "SessionEnd" => Some(Self::SessionEnd),
            "UserPromptSubmit" => Some(Self::UserPromptSubmit),
            _ => None,
        }
    }
}

/// A single hook definition loaded from settings.json.
#[derive(Debug, Clone)]
pub struct HookConfig {
    pub event: HookEvent,
    pub matcher: Option<String>,
    pub command: String,
}

/// The outcome of running a hook command.
#[derive(Debug, Clone)]
pub struct HookResult {
    pub exit_code: i32,
    pub stdout: String,
    /// `true` when the hook's exit code indicates the wrapped action
    /// should be cancelled. For `PreToolUse`, this means skip the tool.
    pub veto: bool,
}

/// Read hooks from `<home>/.claude/settings.json`. Silently returns an
/// empty list if the file is missing or malformed.
pub fn load_hooks() -> Vec<HookConfig> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        let path = PathBuf::from(home).join(".claude").join("settings.json");
        load_hooks_from(&path, &mut out);
    }
    out
}

/// Read hooks from a project's `.claude/settings.json` and merge with the
/// global hooks. Project hooks are appended after global hooks (both run).
pub fn load_hooks_with_project(project_path: &str) -> Vec<HookConfig> {
    let mut out = load_hooks();
    if !project_path.is_empty() {
        let path = PathBuf::from(project_path)
            .join(".claude")
            .join("settings.json");
        load_hooks_from(&path, &mut out);
    }
    out
}

fn load_hooks_from(path: &std::path::Path, out: &mut Vec<HookConfig>) {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let json: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "Hooks: settings.json parse error");
            return;
        }
    };
    let arr = match json.get("hooks").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return,
    };
    for entry in arr {
        let event = entry
            .get("event")
            .and_then(|v| v.as_str())
            .and_then(HookEvent::parse);
        let command = entry
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let matcher = entry
            .get("matcher")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        match (event, command) {
            (Some(event), Some(command)) if !command.is_empty() => {
                out.push(HookConfig {
                    event,
                    matcher,
                    command,
                });
            }
            _ => {
                warn!(path = %path.display(), "Hooks: skipping entry missing event or command");
            }
        }
    }
}

/// Test whether a `matcher` selector applies to a given tool call.
///
/// - `None` matches every tool.
/// - `"<ToolName>"` matches by exact tool name (e.g. `"bash"`, `"write_file"`).
/// - `"Bash(<prefix>:*)"` matches when the tool is `bash` and its `command`
///   argument starts with `<prefix>`. This loosely mirrors Claude Code's
///   permissions-style matcher.
pub fn matches_tool_call(matcher: Option<&str>, tool_name: &str, args: &Value) -> bool {
    let m = match matcher {
        None => return true,
        Some(s) => s.trim(),
    };
    if m.is_empty() {
        return true;
    }

    // Bash(<prefix>:*) — prefix-match the bash command argument.
    if let Some(rest) = m.strip_prefix("Bash(") {
        if let Some(inner) = rest.strip_suffix(')') {
            // Case-insensitive tool name match.
            if !tool_name.eq_ignore_ascii_case("bash") {
                return false;
            }
            // Strip optional :* suffix; treat the remainder as a literal prefix.
            let prefix = inner.strip_suffix(":*").unwrap_or(inner);
            let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            return cmd.starts_with(prefix);
        }
    }

    // Bare tool name (case-insensitive).
    m.eq_ignore_ascii_case(tool_name)
}

/// Spawn the hook command, pipe `payload` to its stdin as JSON, and capture
/// stdout / exit code. Bounded to a 5-second timeout.
pub async fn run_hook(hook: &HookConfig, payload: Value) -> Result<HookResult, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&hook.command);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&hook.command);
        c
    };

    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Ensure a runaway hook child is reaped if we bail out (e.g. on
        // timeout below). Dropping the `Child` will SIGKILL the process on
        // Unix / TerminateProcess on Windows instead of leaving a zombie.
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn hook command: {}", e))?;

    // Pipe the payload to stdin and drop the handle so the child sees EOF.
    if let Some(mut stdin) = child.stdin.take() {
        let body = match serde_json::to_vec(&payload) {
            Ok(b) => b,
            Err(e) => {
                warn!(
                    error = %e,
                    "Hooks: failed to serialize hook payload to JSON; falling back to empty object"
                );
                b"{}".to_vec()
            }
        };
        if let Err(e) = stdin.write_all(&body).await {
            warn!(error = %e, "Hooks: failed to write payload to hook stdin");
        }
        // Explicitly drop to close stdin.
        drop(stdin);
    }

    let timeout = Duration::from_secs(5);
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("Hook process error: {}", e)),
        Err(_) => {
            // `child` was consumed by `wait_with_output`, but that future
            // internally owns the `Child` with `kill_on_drop(true)`, so
            // dropping the timed-out future will terminate the process.
            warn!(
                command = %hook.command,
                timeout_secs = timeout.as_secs(),
                "Hooks: hook exceeded timeout; killing runaway child"
            );
            return Err(format!("Hook timed out after {}s", timeout.as_secs()));
        }
    };

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let veto = exit_code != 0;

    debug!(
        command = %hook.command,
        exit_code = exit_code,
        veto = veto,
        "Hook completed"
    );

    Ok(HookResult {
        exit_code,
        stdout,
        veto,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matcher_none_matches_anything() {
        assert!(matches_tool_call(None, "bash", &json!({})));
        assert!(matches_tool_call(None, "write_file", &json!({})));
    }

    #[test]
    fn matcher_empty_matches_anything() {
        assert!(matches_tool_call(Some(""), "bash", &json!({})));
        assert!(matches_tool_call(Some("   "), "write_file", &json!({})));
    }

    #[test]
    fn matcher_bare_name_is_case_insensitive() {
        assert!(matches_tool_call(Some("bash"), "bash", &json!({})));
        assert!(matches_tool_call(Some("Bash"), "bash", &json!({})));
        assert!(!matches_tool_call(Some("bash"), "write_file", &json!({})));
    }

    #[test]
    fn matcher_bash_prefix_matches_command() {
        let args = json!({ "command": "git push origin main" });
        assert!(matches_tool_call(Some("Bash(git push:*)"), "bash", &args));
        assert!(!matches_tool_call(Some("Bash(git pull:*)"), "bash", &args));
        // Wrong tool — never matches a Bash(...) selector.
        assert!(!matches_tool_call(
            Some("Bash(git push:*)"),
            "write_file",
            &args
        ));
    }

    #[test]
    fn matcher_bash_prefix_without_star_suffix() {
        let args = json!({ "command": "ls -la" });
        assert!(matches_tool_call(Some("Bash(ls)"), "bash", &args));
    }
}
