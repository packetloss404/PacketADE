//! SSH implementations of API-agent tools. Each fn runs a small shell
//! script on the remote host via the system `ssh` binary.

use crate::commands::ssh_keys;
use crate::core::execution::{resolve_remote_path, sh_quote, SshConfig};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tracing::info;

const MAX_FILE_SIZE: u64 = 2_000_000;
const MAX_OUTPUT_SIZE: usize = 262_144;
const DEFAULT_BASH_TIMEOUT: u64 = 30;
const SSH_OVERHEAD_SECS: u64 = 10;

/// Look up a saved SSH password from the keychain for this target.
fn load_password(config: &SshConfig) -> Option<String> {
    let id = config.target_id.as_ref()?;
    ssh_keys::load_ssh_password(id).ok().flatten()
}

/// Run an SSH command. If a password is saved in the keychain for this
/// target, it's piped to stdin (and `BatchMode=yes` is dropped so SSH
/// will accept it). Otherwise key-only auth is used.
///
/// Note: when password auth is in use, the remote process's stdin is
/// occupied by the password — callers cannot use `stdin_data` and must
/// embed any payload directly in `remote_cmd` (e.g. via heredoc).
async fn ssh_run(
    config: &SshConfig,
    remote_cmd: &str,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let password = load_password(config);
    let password_auth = password.is_some();

    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(config.ssh_args(password_auth));
    cmd.arg(remote_cmd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        if let Some(pw) = password {
            // OpenSSH on Windows reads the password from stdin when stdin
            // is not a TTY. After writing it we close stdin so the remote
            // process sees EOF rather than waiting on input.
            stdin
                .write_all(format!("{}\n", pw).as_bytes())
                .await
                .map_err(|e| format!("Failed to write ssh stdin: {}", e))?;
        }
        stdin.shutdown().await.ok();
    }

    let output = tokio::time::timeout(
        Duration::from_secs(timeout_secs + SSH_OVERHEAD_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("SSH command timed out after {} seconds", timeout_secs))?
    .map_err(|e| format!("SSH failed: {}", e))?;

    Ok(output)
}

/// Public wrapper around `ssh_run` for non-tool consumers (e.g., worktree
/// provisioning). Uses a 30s timeout suitable for short git commands.
pub async fn ssh_run_for_worktree(
    config: &SshConfig,
    remote_cmd: &str,
) -> Result<std::process::Output, String> {
    ssh_run(config, remote_cmd, 30).await
}

pub async fn execute_read_file(
    args: &serde_json::Value,
    config: &SshConfig,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;

    let full = resolve_remote_path(&config.remote_path, path)?;
    info!(remote_path = %full, "Tool(ssh): read_file");

    let script = format!(
        "p={q}\n\
         if [ ! -f \"$p\" ]; then echo \"ERR:not_file:$p\" >&2; exit 2; fi\n\
         sz=$(wc -c <\"$p\")\n\
         if [ \"$sz\" -gt {max} ]; then echo \"ERR:too_large:$sz\" >&2; exit 3; fi\n\
         cat -- \"$p\"\n",
        q = sh_quote(&full),
        max = MAX_FILE_SIZE,
    );

    let output = ssh_run(config, &script, 60).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        return Err(format!(
            "read_file failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Pick a heredoc terminator that does not appear in `content`. Tries a
/// random suffix; if (vanishingly unlikely) it collides with the content,
/// extends the suffix and retries.
fn pick_heredoc_terminator(content: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    loop {
        let candidate = format!("PACKETCODE_EOF_{:x}", suffix);
        if !content.contains(&candidate) {
            return candidate;
        }
        suffix = suffix.wrapping_mul(31).wrapping_add(7);
    }
}

pub async fn execute_write_file(
    args: &serde_json::Value,
    config: &SshConfig,
) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'path' parameter")?;
    let content = args
        .get("content")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'content' parameter")?;

    let full = resolve_remote_path(&config.remote_path, path)?;
    info!(remote_path = %full, bytes = content.len(), "Tool(ssh): write_file");

    // Embed the content via a single-quoted heredoc so we don't depend on
    // the SSH stdin (which may be carrying the password).
    let eof = pick_heredoc_terminator(content);
    let script = format!(
        "p={q}\n\
         mkdir -p \"$(dirname \"$p\")\" && cat > \"$p\" <<'{eof}'\n\
         {content}\n\
         {eof}\n",
        q = sh_quote(&full),
        eof = eof,
        content = content,
    );

    let output = ssh_run(config, &script, 60).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        return Err(format!(
            "write_file failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }

    Ok(format!(
        "Successfully wrote {} bytes to {}",
        content.len(),
        path
    ))
}

pub async fn execute_list_directory(
    args: &serde_json::Value,
    config: &SshConfig,
) -> Result<String, String> {
    let path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");

    let full = resolve_remote_path(&config.remote_path, path)?;
    info!(remote_path = %full, "Tool(ssh): list_directory");

    let script = format!(
        "p={q}\n\
         if [ ! -d \"$p\" ]; then echo \"ERR:not_dir:$p\" >&2; exit 2; fi\n\
         cd \"$p\" || exit 4\n\
         ls -A1 2>/dev/null | head -500 | while IFS= read -r name; do\n\
           case \"$name\" in .*) continue;; esac\n\
           if [ -d \"$name\" ]; then\n\
             echo \"[DIR] $name\"\n\
           else\n\
             echo \"$name\"\n\
           fi\n\
         done | sort\n",
        q = sh_quote(&full),
    );

    let output = ssh_run(config, &script, 30).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        return Err(format!(
            "list_directory failed (exit {}): {}",
            code,
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

pub async fn execute_bash(args: &serde_json::Value, config: &SshConfig) -> Result<String, String> {
    let command = args
        .get("command")
        .and_then(|c| c.as_str())
        .ok_or("Missing 'command' parameter")?;
    let timeout_secs = args
        .get("timeout")
        .and_then(|t| t.as_u64())
        .unwrap_or(DEFAULT_BASH_TIMEOUT)
        .min(120);

    info!(command = %command, timeout = %timeout_secs, "Tool(ssh): bash");

    let remote_cmd = format!("cd {} && {}", sh_quote(&config.remote_path), command);

    let output = ssh_run(config, &remote_cmd, timeout_secs).await?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push_str("\n--- stderr ---\n");
        }
        result.push_str(&stderr);
    }

    if result.len() > MAX_OUTPUT_SIZE {
        result.truncate(MAX_OUTPUT_SIZE);
        result.push_str("\n... [output truncated]");
    }

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code != 0 {
        if result.is_empty() {
            result = format!("[exit code: {}]", exit_code);
        } else {
            result.push_str(&format!("\n[exit code: {}]", exit_code));
        }
        return Err(result);
    }

    Ok(result)
}

pub async fn execute_grep(args: &serde_json::Value, config: &SshConfig) -> Result<String, String> {
    let pattern = args
        .get("pattern")
        .and_then(|p| p.as_str())
        .ok_or("Missing 'pattern' parameter")?;
    let search_path = args.get("path").and_then(|p| p.as_str()).unwrap_or(".");
    let include = args.get("include").and_then(|i| i.as_str());

    let full = resolve_remote_path(&config.remote_path, search_path)?;
    info!(pattern = %pattern, remote_path = %full, "Tool(ssh): grep");

    let mut cmd = String::from(
        "grep -rEn --color=never \
         --exclude-dir=.git --exclude-dir=node_modules \
         --exclude-dir=target --exclude-dir=dist --exclude-dir=build",
    );
    if let Some(inc) = include {
        cmd.push_str(" --include=");
        cmd.push_str(&sh_quote(inc));
    }
    cmd.push_str(&format!(
        " -e {} {} 2>/dev/null | head -100",
        sh_quote(pattern),
        sh_quote(&full),
    ));

    let output = ssh_run(config, &cmd, 60).await?;

    let text = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    if text.is_empty() {
        Ok(format!("No matches found for pattern '{}'", pattern))
    } else {
        Ok(text)
    }
}
