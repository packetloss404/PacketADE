use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const VERSION_MAX_LEN: usize = 60;

/// Synchronous PATH check kept for legacy callers (used by `detect_agent`
/// command). Does NOT run the version probe — back-compat callers only
/// care about the boolean. New code should use [`resolve_path`].
pub fn detect_agent(command: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        if sync_where_lookup(command).is_some() {
            return true;
        }
        sync_where_lookup(&format!("{}.cmd", command)).is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::process::Command;
        Command::new("which")
            .arg(command)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| first_nonempty_line(&o.stdout))
            .is_some()
    }
}

#[cfg(target_os = "windows")]
fn sync_where_lookup(name: &str) -> Option<String> {
    use std::process::Command;
    let mut cmd = Command::new("where");
    cmd.arg(name);
    crate::core::shared::hide_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    first_nonempty_line(&output.stdout)
}

/// Resolve a binary on PATH and return its absolute path. Async so concurrent
/// callers (e.g., `detect_cli_catalog` via `join_all`) don't block the runtime.
///
/// Uses `where` on Windows (also probing the `.cmd` wrapper if needed)
/// and `which` on POSIX. Each probe is wrapped in a 2-second timeout so
/// a hijacked `which`/`where` cannot stall the whole sweep.
pub async fn resolve_path(command: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = where_lookup_async(command).await {
            return Some(p);
        }
        let cmd_name = format!("{}.cmd", command);
        if let Some(p) = where_lookup_async(&cmd_name).await {
            return Some(p);
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = TokioCommand::new("which");
        cmd.arg(command);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());
        cmd.kill_on_drop(true);
        let child = cmd.spawn().ok()?;
        match timeout(PATH_PROBE_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(output)) if output.status.success() => first_nonempty_line(&output.stdout),
            _ => None,
        }
    }
}

#[cfg(target_os = "windows")]
async fn where_lookup_async(name: &str) -> Option<String> {
    let mut cmd = TokioCommand::new("where");
    cmd.arg(name);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    cmd.kill_on_drop(true);
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn().ok()?;
    match timeout(PATH_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => first_nonempty_line(&output.stdout),
        _ => None,
    }
}

fn first_nonempty_line(buf: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(buf);
    for line in s.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Probe a binary's version by trying `--version` then `-v`, each capped at 3s.
/// Returns the first non-empty line of stdout (falling back to stderr), trimmed
/// and truncated to [`VERSION_MAX_LEN`] characters.
pub async fn probe_version(binary: &str) -> Option<String> {
    for arg in ["--version", "-v"] {
        if let Some(v) = run_version_probe(binary, arg).await {
            return Some(clamp_version(&v));
        }
    }
    None
}

/// Variant of [`probe_version`] that targets an absolute path instead of
/// resolving on PATH. Used by the manual-override detection branch — the
/// user has pointed us at a specific binary and we want to honour that
/// exact path without round-tripping through `where`/`which`.
pub async fn probe_version_at(path: &str) -> Option<String> {
    for arg in ["--version", "-v"] {
        if let Some(v) = run_version_probe(path, arg).await {
            return Some(clamp_version(&v));
        }
    }
    None
}

async fn run_version_probe(binary: &str, arg: &str) -> Option<String> {
    let mut cmd = TokioCommand::new(binary);
    cmd.arg(arg);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Ensure a hung probe is killed when the future is dropped on timeout.
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        // Avoid flashing a console window on Windows for the probe.
        // `tokio::process::Command::creation_flags` is available natively
        // on the Windows target without importing `CommandExt`.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().ok()?;
    match timeout(VERSION_PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            if let Some(line) = first_nonempty_line(&output.stdout) {
                return Some(line);
            }
            if let Some(line) = first_nonempty_line(&output.stderr) {
                return Some(line);
            }
            None
        }
        Ok(Err(_)) => None,
        Err(_) => {
            // Timed out — the dropped future + kill_on_drop reaps the child.
            None
        }
    }
}

/// True iff the path exists and points at a regular file. On POSIX, also
/// verifies that at least one execute bit is set on the file mode — a
/// non-executable file at a user-supplied "manual path" is almost certainly
/// a misconfiguration and we'd rather flag it than silently probe-fail.
/// On Windows file permissions don't gate exec the same way, so we only
/// require the regular-file check there.
pub fn is_executable_file(path: &str) -> bool {
    let p = std::path::Path::new(path);
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(p) {
            Ok(meta) => meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn clamp_version(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= VERSION_MAX_LEN {
        return trimmed.to_string();
    }
    trimmed.chars().take(VERSION_MAX_LEN).collect()
}
