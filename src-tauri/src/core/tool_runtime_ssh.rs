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

/// Exit code emitted by the remote scripts when the resolved (symlink-followed)
/// path escapes the workspace base.
const EXIT_ESCAPE: i32 = 8;
/// Exit code emitted by the remote scripts when `realpath` is unavailable so
/// confinement cannot be verified (fail closed).
const EXIT_NO_REALPATH: i32 = 9;

/// Emit a POSIX-sh confinement prelude that realpath-resolves the workspace
/// `base` (which may itself be reached via a symlink) and the resolved
/// target, then verifies the target stays inside the base. Fails CLOSED:
/// missing `realpath` exits [`EXIT_NO_REALPATH`] and an escape exits
/// [`EXIT_ESCAPE`].
///
/// This complements (does not replace) the cheap lexical
/// [`resolve_remote_path`] first-pass — this realpath check is the
/// authoritative confinement because it follows symlinks on the remote.
///
/// `base_q` / `tgt_q` are already `sh_quote`d shell words. `resolve_target`
/// selects whether the target itself must resolve (`Existing`, for read /
/// list / grep) or only its parent directory must resolve (`Parent`, for
/// write_file whose leaf may not exist yet — mirroring the local
/// canonicalize-the-parent behaviour).
enum ConfineTarget {
    /// The target path must already exist and realpath-resolve.
    Existing,
    /// Only the target's parent must resolve (leaf may be created).
    Parent,
}

fn confine_prelude(base_q: &str, tgt_q: &str, mode: ConfineTarget) -> String {
    // `realpath -- <base>` first; if realpath is missing on the remote the
    // command fails and we exit EXIT_NO_REALPATH (fail closed). The trailing
    // slash on both the base and the candidate prevents "/workspace-evil"
    // from matching "/workspace".
    let base_line = format!(
        "__base=$(realpath -- {base}) || exit {nr}\n",
        base = base_q,
        nr = EXIT_NO_REALPATH
    );
    match mode {
        ConfineTarget::Existing => format!(
            "{base}__rp=$(realpath -- {tgt}) || exit {nr}\n\
             case \"$__rp/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n",
            base = base_line,
            tgt = tgt_q,
            nr = EXIT_NO_REALPATH,
            esc = EXIT_ESCAPE,
        ),
        // Resolve the parent (the leaf may not exist yet), AND — if the leaf
        // already exists — resolve the leaf itself. A pre-existing symlinked
        // leaf pointing outside the workspace would otherwise be written
        // through even though its parent is in-workspace; the local tool
        // (tool_runtime.rs) canonicalizes an existing leaf for exactly this
        // reason, so we mirror that defense rather than confining the parent
        // alone.
        ConfineTarget::Parent => format!(
            "{base}__rp=$(realpath -- \"$(dirname -- {tgt})\") || exit {nr}\n\
             case \"$__rp/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n\
             if [ -e {tgt} ] || [ -L {tgt} ]; then\n\
             __rpl=$(realpath -- {tgt}) || exit {nr}\n\
             case \"$__rpl/\" in \"$__base\"/*) : ;; *) exit {esc};; esac\n\
             fi\n",
            base = base_line,
            tgt = tgt_q,
            nr = EXIT_NO_REALPATH,
            esc = EXIT_ESCAPE,
        ),
    }
}

/// Map a remote-script exit status to a confinement-specific error message,
/// or `None` if the failure was not a confinement failure (caller handles
/// the generic case).
fn confinement_error(code: i32) -> Option<String> {
    match code {
        EXIT_ESCAPE => {
            Some("Path escapes the workspace (resolved outside via symlink)".to_string())
        }
        EXIT_NO_REALPATH => {
            Some("Remote host lacks 'realpath'; cannot verify workspace confinement".to_string())
        }
        _ => None,
    }
}

/// Look up a saved SSH password from the keychain for this target.
fn load_password(config: &SshConfig) -> Option<String> {
    let id = config.target_id.as_ref()?;
    ssh_keys::load_ssh_password(id).ok().flatten()
}

/// Run an SSH command. If a password is saved in the keychain for this
/// target, `BatchMode=yes` is dropped so SSH will accept interactive auth.
/// On Windows the password is piped to ssh's stdin (OpenSSH-for-Windows reads
/// it from a non-TTY stdin); on Unix the self-reinvoked askpass helper supplies
/// it without exposing the secret in argv or an environment value.
///
/// Note: on Windows, when password auth is in use the remote process's stdin
/// is occupied by the password — callers cannot use `stdin_data` and must
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
    // Reap the ssh child if we bail out on the timeout below instead of leaving
    // it running; dropping the `Child` then terminates the OS process.
    cmd.kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    #[cfg(unix)]
    let _askpass_guard = password
        .as_deref()
        .map(|pw| crate::core::ssh_askpass::arm(&mut cmd, pw))
        .transpose()?;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        // F06/F11: only OpenSSH-for-Windows reads the auth password from a
        // non-TTY stdin. On Unix, ssh reads it from /dev/tty instead, so writing
        // it to stdin does nothing for authentication — and worse, on a
        // ControlMaster-multiplexed connection the client performs no auth at all
        // and forwards those stdin bytes straight to the remote command, leaking
        // the password. So feed the password only on Windows; elsewhere just
        // close stdin so the remote sees EOF.
        #[cfg(windows)]
        {
            if let Some(pw) = password.as_ref() {
                stdin
                    .write_all(format!("{}\n", pw).as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write ssh stdin: {}", e))?;
            }
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

/// Public wrapper for long-running remote git operations (Phase 3.2 — `git
/// clone` of large repos can take many minutes). Caller picks the timeout
/// in seconds.
pub async fn ssh_run_with_timeout(
    config: &SshConfig,
    remote_cmd: &str,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    ssh_run(config, remote_cmd, timeout_secs).await
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
         {confine}\
         if [ ! -f \"$p\" ]; then echo \"ERR:not_file:$p\" >&2; exit 2; fi\n\
         sz=$(wc -c <\"$p\")\n\
         if [ \"$sz\" -gt {max} ]; then echo \"ERR:too_large:$sz\" >&2; exit 3; fi\n\
         cat -- \"$p\"\n",
        q = sh_quote(&full),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Existing
        ),
        max = MAX_FILE_SIZE,
    );

    let output = ssh_run(config, &script, 60).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
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
    // Create the parent first so realpath can resolve it, then confine on the
    // PARENT (the leaf may not exist yet — mirrors the local
    // canonicalize-the-parent behaviour), then write. The `cat > ... <<'EOF'`
    // and its heredoc body must stay adjacent and untouched.
    let script = format!(
        "p={q}\n\
         mkdir -p \"$(dirname \"$p\")\" || exit 5\n\
         {confine}\
         cat > \"$p\" <<'{eof}'\n\
         {content}\n\
         {eof}\n",
        q = sh_quote(&full),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Parent
        ),
        eof = eof,
        content = content,
    );

    let output = ssh_run(config, &script, 60).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
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
         {confine}\
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
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Existing
        ),
    );

    let output = ssh_run(config, &script, 30).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
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
        crate::core::tool_runtime::truncate_to_char_boundary(&mut result, MAX_OUTPUT_SIZE);
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

    // Bind the resolved path to `p` so the confinement prelude can realpath
    // it and `exit` (8/9) BEFORE grep runs if it escapes the workspace. The
    // grep pipeline's own exit status is masked by `head`, so a confinement
    // failure is only observable via this early `exit`.
    let mut cmd = format!(
        "p={q}\n{confine}",
        q = sh_quote(&full),
        confine = confine_prelude(
            &sh_quote(&config.remote_path),
            "\"$p\"",
            ConfineTarget::Existing
        ),
    );
    cmd.push_str(
        "grep -rEn --color=never \
         --exclude-dir=.git --exclude-dir=node_modules \
         --exclude-dir=target --exclude-dir=dist --exclude-dir=build",
    );
    if let Some(inc) = include {
        cmd.push_str(" --include=");
        cmd.push_str(&sh_quote(inc));
    }
    cmd.push_str(&format!(
        " -e {} \"$p\" 2>/dev/null | head -100\n",
        sh_quote(pattern),
    ));

    let output = ssh_run(config, &cmd, 60).await?;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        if let Some(msg) = confinement_error(code) {
            return Err(msg);
        }
        // Any other nonzero status (e.g. grep exit 1 = no matches) is not an
        // error here — fall through to the stdout-based handling below.
    }

    let text = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    if text.is_empty() {
        Ok(format!("No matches found for pattern '{}'", pattern))
    } else {
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_confine_also_rejects_existing_symlinked_leaf() {
        // Regression: confining only the parent dir let a pre-existing
        // symlinked leaf (link -> /etc) be written through, since dirname is
        // in-workspace. The Parent prelude must also resolve+confine the leaf
        // when it already exists, mirroring the local canonicalize-the-leaf
        // defense in tool_runtime.rs.
        let s = confine_prelude("'/ws'", "\"$p\"", ConfineTarget::Parent);
        assert!(s.contains("dirname --"), "parent dir is resolved");
        assert!(
            s.contains("if [ -e \"$p\" ] || [ -L \"$p\" ]; then"),
            "existing-leaf branch present"
        );
        assert!(
            s.contains("__rpl=$(realpath -- \"$p\")"),
            "leaf is realpath-resolved"
        );
        // base + parent + leaf each fail closed when realpath is missing.
        assert_eq!(
            s.matches(&format!("exit {}", EXIT_NO_REALPATH)).count(),
            3,
            "fail-closed on base, parent, and leaf"
        );
        // parent-escape and leaf-escape are both rejected.
        assert_eq!(
            s.matches(&format!("exit {}", EXIT_ESCAPE)).count(),
            2,
            "escape rejected for parent and leaf"
        );
    }

    #[test]
    fn existing_confine_has_no_leaf_or_parent_branch() {
        let s = confine_prelude("'/ws'", "\"$p\"", ConfineTarget::Existing);
        assert!(!s.contains("dirname --"));
        assert!(!s.contains("__rpl"));
        // base + the single existing-target resolve.
        assert_eq!(s.matches(&format!("exit {}", EXIT_NO_REALPATH)).count(), 2);
        assert_eq!(s.matches(&format!("exit {}", EXIT_ESCAPE)).count(), 1);
    }
}
