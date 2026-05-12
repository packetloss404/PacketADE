use super::shared::lock_mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tracing::{info, warn};

use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

fn pty_output_event(session_id: &str) -> String {
    format!("pty:output:{}", session_id)
}

fn pty_exit_event(session_id: &str) -> String {
    format!("pty:exit:{}", session_id)
}

/// Commands allowed to be spawned in a PTY session.
const ALLOWED_COMMANDS: &[&str] = &[
    "claude",
    "codex",
    "gemini",
    "opencode",
    "packetcode",
    "bash",
    "sh",
    "zsh",
    "powershell",
    "cmd",
    "ssh",
];

/// Resolve a command name to its actual path on Windows.
/// Uses `where` to find the binary — returns the first match.
/// Prefers .exe over .cmd when both exist.
#[cfg(windows)]
fn resolve_windows_command(command: &str) -> String {
    use super::shared::hide_window;

    let mut where_cmd = std::process::Command::new("where");
    where_cmd.arg(command);
    hide_window(&mut where_cmd);

    if let Ok(output) = where_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let lines: Vec<&str> = stdout
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();

            // Prefer .exe over .cmd; skip extensionless entries (npm shell stubs)
            if let Some(exe) = lines.iter().find(|l| l.ends_with(".exe")) {
                return exe.to_string();
            }
            if let Some(cmd_file) = lines.iter().find(|l| l.ends_with(".cmd")) {
                return cmd_file.to_string();
            }
            // Last resort: any entry with a file extension
            if let Some(with_ext) = lines.iter().find(|l| {
                l.rsplit('\\')
                    .next()
                    .map(|f| f.contains('.'))
                    .unwrap_or(false)
            }) {
                return with_ext.to_string();
            }
            if let Some(first) = lines.first() {
                return first.to_string();
            }
        }
    }

    // Fallback: try .cmd extension (legacy behavior)
    format!("{}.cmd", command)
}

/// Info about a running PTY session
#[derive(Clone, Serialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub project_path: String,
    pub pid: Option<u32>,
    pub alive: bool,
}

/// Internal state for one PTY session
struct PtySession {
    info: PtySessionInfo,
    child: Box<dyn PtyChild + Send>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    kill_flag: Arc<std::sync::atomic::AtomicBool>,
}

/// Manages all PTY sessions
pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Kill multiple PTY sessions by ID. Skips missing sessions.
    pub fn kill_sessions(&mut self, session_ids: &[String]) {
        for session_id in session_ids {
            if let Some(mut session) = self.sessions.remove(session_id) {
                info!(session_id = %session_id, "Killing PTY session (flight cleanup)");
                session
                    .kill_flag
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                session.info.alive = false;
                let _ = session.child.kill();
            }
        }
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;

pub fn create_shared_pty_manager() -> SharedPtyManager {
    Arc::new(Mutex::new(PtyManager::new()))
}

#[tauri::command]
pub fn create_pty_session(
    app: AppHandle,
    manager: State<'_, SharedPtyManager>,
    project_path: String,
    cols: u16,
    rows: u16,
    command: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    // Validate command against allowlist
    if !ALLOWED_COMMANDS.iter().any(|&c| c == command) {
        return Err(format!(
            "Command '{}' is not allowed. Allowed commands: {:?}",
            command, ALLOWED_COMMANDS
        ));
    }

    // Validate project_path is a real directory (skip for SSH — remote path is not local)
    let project_path = if command == "ssh" {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| project_path.clone())
    } else {
        let project_dir = std::path::Path::new(&project_path);
        if !project_dir.is_dir() {
            return Err(format!(
                "Project path '{}' is not a valid directory",
                project_path
            ));
        }
        project_path
    };

    info!(command = %command, project_path = %project_path, "Creating PTY session");

    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build the command: launch the specified CLI interactively.
    // On Windows, CLIs may be installed as .exe (e.g. claude.exe) or .cmd wrappers
    // (e.g. codex.cmd). We use `where` to resolve the actual binary path and choose
    // the right spawn strategy.
    let mut cmd = if cfg!(windows) {
        let resolved = resolve_windows_command(&command);
        if resolved.ends_with(".cmd") {
            // .cmd batch scripts must go through cmd.exe /c
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/c");
            c.arg(&resolved);
            c
        } else {
            // Native .exe — spawn directly
            CommandBuilder::new(&resolved)
        }
    } else {
        CommandBuilder::new(&command)
    };
    cmd.cwd(&project_path);

    // Append any extra arguments (e.g. --model)
    if let Some(extra_args) = &args {
        for arg in extra_args {
            cmd.arg(arg);
        }
    }

    // Clear env vars that make Claude think it's inside another session
    if command == "claude" {
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        // Tell statusline.ps1 to suppress terminal output (PacketADE has its own native status bar).
        // PACKETCODE env var retained for backwards compatibility with any existing scripts.
        cmd.env("PACKETADE", "1");
        cmd.env("PACKETCODE", "1");
    }

    // Gemini CLI env setup
    if command == "gemini" {
        cmd.env("PACKETCODE", "1");
    }

    // PTY is a real terminal — advertise a common modern terminal profile so CLIs
    // enable their interactive UI and 24-bit color output.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Apply any extra environment variables from the frontend
    if let Some(extra_env) = &env {
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
    }

    // Spawn the child process in the PTY
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        format!(
            "Failed to spawn {} in PTY: {}. Is {} installed?",
            command, e, command
        )
    })?;

    let pid = child.process_id();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let kill_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let info = PtySessionInfo {
        id: session_id.clone(),
        project_path: project_path.clone(),
        pid,
        alive: true,
    };

    let session = PtySession {
        info: info.clone(),
        child,
        writer,
        master: pair.master,
        kill_flag: kill_flag.clone(),
    };

    {
        let mut mgr = lock_mutex(&manager)?;
        mgr.sessions.insert(session_id.clone(), session);
    }

    // Spawn a thread to read PTY output and emit events
    let sid = session_id.clone();
    let app_handle = app.clone();
    let mgr_ref = manager.inner().clone();

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Carry-over bytes from incomplete UTF-8 sequences at read boundaries
        let mut pending: Vec<u8> = Vec::new();
        loop {
            if kill_flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }

            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — process exited
                Ok(n) => {
                    let data = crate::core::pty::decode_terminal_chunk(&buf[..n], &mut pending);
                    if let Err(e) = app_handle.emit(&pty_output_event(&sid), &data) {
                        warn!(session_id = %sid, error = %e, "Failed to emit scoped pty output");
                    }
                }
                Err(e) => {
                    // On Windows, ERROR_BROKEN_PIPE means the child exited
                    let err_str = e.to_string();
                    if err_str.contains("broken pipe")
                        || err_str.contains("The pipe has been ended")
                        || e.kind() == std::io::ErrorKind::BrokenPipe
                    {
                        break;
                    }
                    // Transient errors — retry
                    thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }

        // Remove session so stale entries cannot accumulate.
        if let Ok(mut mgr) = mgr_ref.lock() {
            mgr.sessions.remove(&sid);
        }

        info!(session_id = %sid, "PTY session exited");
        if let Err(e) = app_handle.emit(&pty_exit_event(&sid), &sid) {
            warn!(session_id = %sid, error = %e, "Failed to emit scoped pty exit");
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub fn write_pty(
    manager: State<'_, SharedPtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    super::validate_input_size(&data, super::MAX_PTY_WRITE_SIZE, "PTY write data")?;
    let mut mgr = lock_mutex(&manager)?;
    let session = mgr
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("PTY session {} not found", session_id))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    manager: State<'_, SharedPtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mgr = lock_mutex(&manager)?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("PTY session {} not found", session_id))?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn kill_pty(manager: State<'_, SharedPtyManager>, session_id: String) -> Result<(), String> {
    let mut mgr = lock_mutex(&manager)?;
    if let Some(mut session) = mgr.sessions.remove(&session_id) {
        info!(session_id = %session_id, "Killing PTY session");
        session
            .kill_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        session.info.alive = false;
        if let Err(e) = session.child.kill() {
            warn!(session_id = %session_id, error = %e, "Failed to kill PTY child process");
        }
    } else {
        return Err(format!("PTY session {} not found", session_id));
    }

    Ok(())
}

#[tauri::command]
pub fn list_pty_sessions(
    manager: State<'_, SharedPtyManager>,
) -> Result<Vec<PtySessionInfo>, String> {
    let mgr = lock_mutex(&manager)?;
    Ok(mgr.sessions.values().map(|s| s.info.clone()).collect())
}

#[tauri::command]
pub fn kill_pty_and_wait(
    manager: State<'_, SharedPtyManager>,
    session_id: String,
) -> Result<bool, String> {
    let mut mgr = lock_mutex(&manager)?;
    info!(session_id = %session_id, "Killing PTY session and waiting for exit");
    if let Some(mut session) = mgr.sessions.remove(&session_id) {
        session
            .kill_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        session.info.alive = false;
        if let Err(e) = session.child.kill() {
            warn!(session_id = %session_id, error = %e, "Failed to kill PTY child process");
        }
        // Wait briefly for cleanup
        drop(mgr);
        std::thread::sleep(std::time::Duration::from_millis(200));
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn read_pty_transcript(session_id: String) -> Result<crate::core::pty::PtyTranscript, String> {
    crate::core::pty::read_transcript(&session_id)
}

/// Run an SSH command as a regular process (not PTY) with optional password piped to stdin.
/// Used for connection tests and agent detection where we need password auth to work
/// reliably on Windows (Windows OpenSSH ignores PTY stdin for password prompts).
#[tauri::command]
pub async fn ssh_exec(
    command_args: Vec<String>,
    password: Option<String>,
) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut cmd = tokio::process::Command::new("ssh");
    for arg in &command_args {
        cmd.arg(arg);
    }

    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    // Feed password to stdin if provided, then close stdin so SSH proceeds
    if let Some(pw) = password {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{}\n", pw).as_bytes()).await;
            let _ = stdin.flush().await;
            drop(stdin);
        }
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("SSH process failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(format!("{}{}", stdout, stderr))
}

/// Test an SSH connection. Returns Ok(()) on success; Err with a human-readable
/// reason on failure ("Authentication failed", "Could not reach host", etc).
#[tauri::command]
pub async fn ssh_test_connection(
    host: String,
    port: u16,
    user: String,
    key_path: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    const SENTINEL: &str = "PACKETCODE_SSH_OK";

    let mut args: Vec<String> = vec![
        "-p".to_string(),
        port.to_string(),
        "-o".to_string(),
        "ConnectTimeout=8".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
    ];

    // If no password, force key-only auth so SSH doesn't hang waiting for a TTY.
    if password.is_none() {
        args.push("-o".to_string());
        args.push("BatchMode=yes".to_string());
    } else {
        args.push("-o".to_string());
        args.push("PreferredAuthentications=password,keyboard-interactive".to_string());
    }

    if let Some(kp) = key_path.as_ref().filter(|s| !s.trim().is_empty()) {
        args.push("-i".to_string());
        args.push(kp.clone());
    }

    args.push(format!("{}@{}", user, host));
    args.push(format!("echo {}", SENTINEL));

    let output = ssh_exec(args, password).await?;

    if output.contains(SENTINEL) {
        return Ok(());
    }

    // Map common failure patterns to friendly messages.
    let lower = output.to_lowercase();
    let msg = if lower.contains("permission denied") || lower.contains("authentication failed") {
        "Authentication failed — check the password, username, or key path."
    } else if lower.contains("could not resolve") || lower.contains("name or service not known") {
        "Could not resolve host — check the hostname."
    } else if lower.contains("connection refused") {
        "Connection refused — check the host is reachable on that port."
    } else if lower.contains("connection timed out") || lower.contains("operation timed out") {
        "Connection timed out — host may be unreachable or behind a firewall."
    } else if lower.contains("host key verification failed") {
        "Host key verification failed — remove the stale entry from known_hosts and retry."
    } else if output.trim().is_empty() {
        "SSH did not respond."
    } else {
        return Err(output.trim().to_string());
    };
    Err(msg.to_string())
}
