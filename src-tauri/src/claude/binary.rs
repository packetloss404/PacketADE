use std::path::PathBuf;
use crate::commands::shared::{hide_window, hide_window_async, home_dir};

/// Discover the Claude CLI binary path.
/// Checks PATH first (via `where` on Windows), then common global install locations.
pub fn find_claude_binary() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("where");
        cmd.arg("claude");
        hide_window(&mut cmd);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let path = PathBuf::from(first_line.trim());
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let path = PathBuf::from(first_line.trim());
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    let home = home_dir().unwrap_or_default();

    let candidates = vec![
        PathBuf::from(&home).join("AppData/Roaming/npm/claude.cmd"),
        PathBuf::from(&home).join("AppData/Roaming/npm/claude"),
        PathBuf::from(&home).join(".local/bin/claude.exe"),
        PathBuf::from(&home).join(".local/bin/claude"),
        PathBuf::from(&home).join(".nvm/versions"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    Some(PathBuf::from("claude"))
}

/// Build a `tokio::process::Command` for the Claude CLI with the correct binary path
/// and Windows console-hiding flags pre-applied.
pub fn claude_command() -> Result<tokio::process::Command, String> {
    let binary = find_claude_binary()
        .ok_or_else(|| "Failed to run Claude CLI: program not found. Is claude installed and on PATH?".to_string())?;

    let mut cmd = tokio::process::Command::new(binary);
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
    hide_window_async(&mut cmd);
    Ok(cmd)
}

/// Run a Claude CLI prompt and return stdout as a String.
/// Optionally sets the working directory to `project_path`.
/// Automatically retries transient errors (rate limits, timeouts, server errors)
/// up to 3 times with jittered exponential backoff.
pub async fn run_claude(prompt: &str, project_path: Option<&str>) -> Result<String, String> {
    use crate::commands::error_classifier::{classify_cli_error, retry_delay_ms};

    const MAX_RETRIES: u32 = 3;

    for attempt in 0..=MAX_RETRIES {
        let mut cmd = claude_command()?;
        cmd.args(&["-p", prompt, "--output-format", "text", "--allowedTools", "Read,Glob,Grep,Bash(read-only)"]);
        if let Some(cwd) = project_path {
            cmd.current_dir(cwd);
        }
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run Claude CLI: {}. Is claude installed and on PATH?", e))?;

        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let classified = classify_cli_error(&stderr);

        if classified.is_transient && attempt < MAX_RETRIES {
            let delay = retry_delay_ms(attempt, 2000, 30000);
            tracing::warn!(
                category = ?classified.category,
                attempt = attempt + 1,
                retry_ms = delay,
                "Transient Claude CLI error, retrying"
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            continue;
        }

        return Err(format!("{} — {}", classified.message, classified.suggestion));
    }

    unreachable!()
}
