use super::shared::lock_mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tracing::{info, warn};

use portable_pty::{
    native_pty_system, Child as PtyChild, ChildKiller as PtyChildKiller, CommandBuilder, MasterPty,
    PtySize,
};
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

/// Extract the program name from a command string for allowlist checks.
/// Strips any directory components and a trailing executable extension so a
/// manually-pinned absolute path (e.g. `D:\tools\packetcode.exe`) validates
/// against the bare-name allowlist by its program name (`packetcode`).
/// Lowercased for case-insensitive comparison on Windows.
fn command_program_name(command: &str) -> String {
    let stem = std::path::Path::new(command)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(command);
    stem.to_ascii_lowercase()
}

/// Resolve a CLI agent command to an absolute executable path.
///
/// 1. An app pin (`~/.packetade/<command>-bin` containing an absolute path) wins
///    if present — an escape hatch to force a specific binary (e.g. when a CLI
///    release crashes in our PTY).
/// 2. Otherwise, resolve a bare command name against PATH to an absolute path.
///    This is important: we always spawn with the pane's cwd, and our PTY layer
///    resolves a *relative* program against cwd FIRST — so a same-named file or
///    directory in the cwd (e.g. a stray `~/claude` dir while cwd is the home
///    dir) would shadow the real CLI and make `exec` fail (EACCES on a dir →
///    "[Session ended]"). Returning an absolute path avoids that entirely.
/// 3. If it can't be resolved, return the name unchanged and let it fail loudly.
#[cfg(not(windows))]
fn resolve_pinned_cli_binary(command: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        let pin = home.join(".packetade").join(format!("{command}-bin"));
        if let Ok(contents) = std::fs::read_to_string(&pin) {
            let path = contents.trim();
            if !path.is_empty() && std::path::Path::new(path).exists() {
                info!(command, pinned = path, "Using app-pinned CLI binary");
                return path.to_string();
            }
        }
    }

    // Already an explicit path — use as-is.
    if command.contains('/') {
        return command.to_string();
    }

    // Resolve the bare name against PATH to an absolute executable file.
    if let Some(path) = std::env::var_os("PATH") {
        use std::os::unix::fs::PermissionsExt;
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(command);
            if let Ok(meta) = std::fs::metadata(&candidate) {
                if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
    }

    command.to_string()
}

/// A neutral, empty working directory for panes opened without a project.
/// Lives in the app data dir so an agent's cwd scan finds nothing sensitive
/// (avoids macOS TCC prompts for ~/Music, ~/Pictures, … that scanning $HOME
/// triggers). Created on demand.
fn neutral_scratch_cwd() -> Option<String> {
    let dir = dirs::home_dir()?
        .join(crate::core::brand::DATA_DIR_NAME)
        .join("scratch");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.to_string_lossy().into_owned())
}

/// Resolve a command name to its actual path on Windows.
/// Uses `where` to find the binary — returns the first match.
/// Prefers .exe over .cmd when both exist.
#[cfg(windows)]
fn resolve_windows_command(command: &str) -> String {
    use super::shared::hide_window;

    // A manually-pinned binary arrives as an explicit path (absolute, or
    // containing a separator). `where` doesn't resolve full paths, so use it
    // directly when it points at a real file.
    let as_path = std::path::Path::new(command);
    if (as_path.is_absolute() || command.contains('\\') || command.contains('/'))
        && as_path.is_file()
    {
        return command.to_string();
    }

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
                    .unwrap_or_else(|| {
                        // `where` output should always be \-delimited on Windows; log if not.
                        warn!(line = %l, "where output line had no \\ separator; treating as no extension");
                        false
                    })
            }) {
                return with_ext.to_string();
            }
            if let Some(first) = lines.first() {
                return first.to_string();
            }
        }
    }

    windows_command_lookup_fallback(command)
}

/// Preserve the requested command when `where` cannot resolve it. Appending a
/// fabricated extension hides the real executable name and turns the eventual
/// spawn failure into a misleading "*.cmd not found" error.
fn windows_command_lookup_fallback(command: &str) -> String {
    command.to_string()
}

/// Info about a running PTY session
#[derive(Clone, Serialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub project_path: String,
    pub pid: Option<u32>,
    pub alive: bool,
}

/// Payload for scoped PTY output. The monotonically increasing sequence lets
/// the frontend join a transcript snapshot with live events without guessing
/// based on repeated terminal text.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub data: String,
    pub sequence: u64,
}

/// Payload for the scoped `pty:exit:{session_id}` event.
///
/// Historically this event carried only the session id string. It now
/// carries the captured child exit code and a `terminated` flag so the
/// frontend can score orchestrated task completion against the REAL
/// outcome (non-zero exit → failure) and distinguish a backend-initiated
/// kill (flight pause/cancel) from a natural exit.
///
/// Backward compatibility: listeners that ignore the payload (or only used
/// the old bare-string session id) keep working — the new fields are
/// additive and optional on the TS side.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitPayload {
    /// Session id — same value the event was historically keyed by.
    pub session_id: String,
    /// Child process exit code, when it could be captured. `None` when the
    /// child status couldn't be read (e.g. it was force-killed and reaped
    /// elsewhere). `0` means success; non-zero means the agent failed.
    pub exit_code: Option<i32>,
    /// True when the session was killed by an orchestrator action
    /// (flight pause/cancel via `kill_sessions`), so the frontend must NOT
    /// score it as a successful task completion.
    pub terminated: bool,
}

fn is_terminal_pty_read_error(error: &std::io::Error) -> bool {
    let err_str = error.to_string();
    err_str.contains("broken pipe")
        || err_str.contains("The pipe has been ended")
        || error.kind() == std::io::ErrorKind::BrokenPipe
        // Unix PTYs commonly report EIO once the slave side closes.
        || error.raw_os_error() == Some(5)
}

/// Shared handle to the spawned child so the reader thread can capture the
/// exit code after the read loop ends, while the manager can still kill it.
type SharedChild = Arc<Mutex<Box<dyn PtyChild + Send>>>;
type SharedChildKiller = Arc<Mutex<Box<dyn PtyChildKiller + Send + Sync>>>;

/// Internal state for one PTY session
struct PtySession {
    info: PtySessionInfo,
    child: SharedChild,
    killer: SharedChildKiller,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    kill_flag: Arc<std::sync::atomic::AtomicBool>,
    /// Set ONLY when an orchestrator action (flight pause/cancel) kills the
    /// session via `kill_sessions`. The reader thread reads this to mark the
    /// emitted `pty:exit` payload `terminated`, so a backend kill isn't
    /// mis-scored as task success.
    orchestrator_killed: Arc<std::sync::atomic::AtomicBool>,
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
    ///
    /// Invoked by orchestrator flight pause/cancel. Sets `orchestrator_killed`
    /// so the reader thread tags the resulting `pty:exit` payload as
    /// `terminated`, preventing the frontend from scoring the kill as a
    /// successful task completion.
    pub fn kill_sessions(&mut self, session_ids: &[String]) {
        for session_id in session_ids {
            if let Some(mut session) = self.sessions.remove(session_id) {
                info!(session_id = %session_id, "Killing PTY session (flight cleanup)");
                session.info.alive = false;
                if let Err(e) = signal_pty_kill(
                    session_id,
                    session.kill_flag.as_ref(),
                    Some(session.orchestrator_killed.as_ref()),
                    &session.killer,
                ) {
                    warn!(session_id = %session_id, error = %e, "Failed to kill PTY child process");
                }
            }
        }
    }
}

fn signal_pty_kill(
    session_id: &str,
    kill_flag: &std::sync::atomic::AtomicBool,
    orchestrator_killed: Option<&std::sync::atomic::AtomicBool>,
    killer: &SharedChildKiller,
) -> std::io::Result<()> {
    if let Some(orchestrator_killed) = orchestrator_killed {
        orchestrator_killed.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    kill_flag.store(true, std::sync::atomic::Ordering::Relaxed);

    let mut killer = killer.lock().map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("PTY child killer mutex poisoned for session {}", session_id),
        )
    })?;
    killer.kill()
}

fn wait_for_pty_child_exit(
    session_id: &str,
    child: &SharedChild,
    timeout: std::time::Duration,
) -> bool {
    let start = std::time::Instant::now();
    loop {
        // The reader thread owns the blocking `wait()` used to capture the
        // exit code for `PtyExitPayload`. Avoid blocking behind that same
        // mutex here; otherwise kill_pty_and_wait can hang instead of timing
        // out when the reader is already waiting.
        match child.try_lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(_)) | Err(_) => return true,
                Ok(None) if start.elapsed() < timeout => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Ok(None) => {
                    warn!(session_id = %session_id, ?timeout, "PTY kill timed out");
                    return false;
                }
            },
            Err(std::sync::TryLockError::WouldBlock) if start.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                warn!(session_id = %session_id, ?timeout, "PTY kill timed out waiting for child handle");
                return false;
            }
            Err(std::sync::TryLockError::Poisoned(_)) => return true,
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
    // Validate command against allowlist. Match on the program name so a
    // manually-pinned absolute path for a known agent (e.g.
    // `D:\projects\packetcode\bin\packetcode.exe`) is accepted by its
    // basename while still rejecting arbitrary programs.
    let program = command_program_name(&command);
    if !ALLOWED_COMMANDS.iter().any(|&c| c == program) {
        return Err(format!(
            "Command '{}' is not allowed. Allowed commands: {:?}",
            command, ALLOWED_COMMANDS
        ));
    }

    // Validate project_path is a real directory (skip for SSH — remote path is not local)
    let project_path = if command == "ssh" {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| {
                // No home dir resolvable — falling back to the caller-supplied path keeps SSH alive
                // but signals an environment issue worth investigating.
                warn!(fallback = %project_path, "dirs::home_dir() returned None for SSH session; using caller path");
                project_path.clone()
            })
    } else {
        let trimmed = project_path.trim();
        // Never launch an interactive CLI at the filesystem root (or with no
        // path at all). An agent spawned at "/" can wander the entire disk and
        // is exactly what triggers broad macOS file-access prompts. Fall back to
        // the user's home directory — the conventional default working dir
        // (what Terminal.app uses) — instead of "/".
        if trimmed.is_empty() || trimmed == "/" {
            // No project selected. Do NOT fall back to "/" (whole-disk wander)
            // OR the home directory: an agent like claude scans its cwd for
            // context, and scanning $HOME walks into ~/Music, ~/Pictures,
            // ~/Documents, … which triggers macOS TCC permission prompts
            // attributed to the app. Use a dedicated empty scratch dir instead —
            // nothing sensitive to scan, no prompts.
            neutral_scratch_cwd().unwrap_or_else(|| {
                warn!(
                    requested = %project_path,
                    "no project path and scratch dir unavailable; falling back to caller path"
                );
                project_path.clone()
            })
        } else {
            let project_dir = std::path::Path::new(trimmed);
            if !project_dir.is_dir() {
                return Err(format!(
                    "Project path '{}' is not a valid directory",
                    project_path
                ));
            }
            project_path
        }
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
    #[cfg(windows)]
    let mut cmd = {
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
    };
    #[cfg(not(windows))]
    let mut cmd = { CommandBuilder::new(resolve_pinned_cli_binary(&command)) };
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
        // The app manages claude's lifecycle; an auto-update mid-session can swap
        // in a build that's incompatible with our PTY (claude 2.1.185 panics on
        // its first PTY write). Stop the launched binary from self-updating so a
        // pinned-good version (see `resolve_pinned_cli_binary`) stays put.
        cmd.env("DISABLE_AUTOUPDATER", "1");
        // Tell statusline.ps1 to suppress terminal output (PacketADE has its own native status bar).
        // PACKETCODE env var retained for backwards compatibility with any existing scripts.
        cmd.env("PACKETADE", "1");
        cmd.env("PACKETCODE", "1");
    }

    // Gemini CLI env setup
    if command == "gemini" {
        cmd.env("PACKETCODE", "1");
        // Google deprecated the gemini CLI's individual OAuth ("Code Assist for
        // individuals"), so interactive sign-in now fails. Inject the stored
        // Gemini API key (Tools → Gemini API Key, kept in the keychain) as
        // GEMINI_API_KEY so the CLI authenticates via the key instead.
        if let Ok(key) = crate::commands::api_keys::load_api_key("gemini") {
            let key = key.trim();
            if !key.is_empty() {
                cmd.env("GEMINI_API_KEY", key);
            }
        }
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

    let killer: SharedChildKiller = Arc::new(Mutex::new(child.clone_killer()));
    let pid = child.process_id();
    let child: SharedChild = Arc::new(Mutex::new(child));

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let kill_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let orchestrator_killed = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let info = PtySessionInfo {
        id: session_id.clone(),
        project_path: project_path.clone(),
        pid,
        alive: true,
    };

    let session = PtySession {
        info: info.clone(),
        child: child.clone(),
        killer,
        writer,
        master: pair.master,
        kill_flag: kill_flag.clone(),
        orchestrator_killed: orchestrator_killed.clone(),
    };

    {
        let mut mgr = lock_mutex(&manager)?;
        mgr.sessions.insert(session_id.clone(), session);
    }

    // Spawn a thread to read PTY output and emit events
    let sid = session_id.clone();
    let app_handle = app.clone();
    let mgr_ref = manager.inner().clone();
    let exit_child = child.clone();

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
                    let sequence = crate::core::pty::append_transcript(&sid, &data);
                    let payload = PtyOutputPayload { data, sequence };
                    if let Err(e) = app_handle.emit(&pty_output_event(&sid), &payload) {
                        warn!(session_id = %sid, error = %e, "Failed to emit scoped pty output");
                    }
                }
                Err(e) => {
                    if is_terminal_pty_read_error(&e) {
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

        // Capture the child exit code now that the read loop has ended. The
        // child may already have been reaped by an explicit `kill()`, in
        // which case `wait()` errors and we report `None`.
        let exit_code = match exit_child.lock() {
            Ok(mut child) => match child.wait() {
                Ok(status) => Some(status.exit_code() as i32),
                Err(e) => {
                    warn!(session_id = %sid, error = %e, "Failed to read PTY child exit status");
                    None
                }
            },
            Err(_) => None,
        };
        let terminated = orchestrator_killed.load(std::sync::atomic::Ordering::Relaxed);

        info!(session_id = %sid, exit_code = ?exit_code, terminated, "PTY session exited");
        let payload = PtyExitPayload {
            session_id: sid.clone(),
            exit_code,
            terminated,
        };
        if let Err(e) = app_handle.emit(&pty_exit_event(&sid), &payload) {
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
        session.info.alive = false;
        if let Err(e) = signal_pty_kill(
            &session_id,
            session.kill_flag.as_ref(),
            None,
            &session.killer,
        ) {
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
    timeout_ms: Option<u64>,
) -> Result<bool, String> {
    const DEFAULT_TIMEOUT_MS: u64 = 200;
    const MAX_TIMEOUT_MS: u64 = 30_000;

    let timeout = std::time::Duration::from_millis(
        timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS),
    );
    let mut mgr = lock_mutex(&manager)?;
    info!(session_id = %session_id, "Killing PTY session and waiting for exit");
    if let Some(mut session) = mgr.sessions.remove(&session_id) {
        session.info.alive = false;
        if let Err(e) = signal_pty_kill(
            &session_id,
            session.kill_flag.as_ref(),
            None,
            &session.killer,
        ) {
            warn!(session_id = %session_id, error = %e, "Failed to kill PTY child process");
        }
        let child = session.child.clone();
        drop(mgr);

        Ok(wait_for_pty_child_exit(&session_id, &child, timeout))
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn read_pty_transcript(session_id: String) -> Result<crate::core::pty::PtyTranscript, String> {
    crate::core::pty::read_transcript(&session_id)
}

/// Run an SSH command as a regular process (not PTY). Windows OpenSSH receives
/// an optional password over stdin; Unix OpenSSH uses the self-reinvoked
/// askpass helper because it never reads a login password from stdin.
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

    #[cfg(unix)]
    let _askpass_guard = password
        .as_deref()
        .map(|pw| crate::core::ssh_askpass::arm(&mut cmd, pw))
        .transpose()?;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    // OpenSSH-for-Windows accepts the password on stdin. Unix must only close
    // this pipe: writing the password can leak it to a multiplexed remote
    // command when no authentication exchange occurs.
    #[cfg(windows)]
    {
        if let Some(pw) = password.as_ref() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(format!("{}\n", pw).as_bytes()).await;
                let _ = stdin.flush().await;
                drop(stdin);
            }
        }
    }
    #[cfg(unix)]
    drop(child.stdin.take());

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("SSH process failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(format!("{}{}", stdout, stderr))
}

/// One discovered host key (algorithm + raw `known_hosts`-format line +
/// derived SHA256 fingerprint). The frontend shows the fingerprint to the
/// user for confirmation; the `key` line is what gets appended to the
/// app-managed `known_hosts` file via `ssh_pin_host`.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub algorithm: String,
    pub key: String,
    pub fingerprint: String,
}

/// Run `ssh-keyscan` for the given host:port and return parsed host keys
/// (one per discovered algorithm). Fingerprints are derived via
/// `ssh-keygen -lf -`. Used by the Servers UI on first save so the user
/// can verify and pin the key before any traffic is sent.
#[tauri::command]
pub async fn ssh_fetch_fingerprint(host: String, port: u16) -> Result<Vec<HostKey>, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut keyscan = tokio::process::Command::new("ssh-keyscan");
    keyscan
        .arg("-T")
        .arg("8")
        .arg("-t")
        .arg("ed25519,rsa,ecdsa")
        .arg("-p")
        .arg(port.to_string())
        .arg(&host);
    keyscan.stdin(Stdio::null());
    keyscan.stdout(Stdio::piped());
    keyscan.stderr(Stdio::piped());

    let output = keyscan
        .output()
        .await
        .map_err(|e| format!("Failed to run ssh-keyscan: {}. Is OpenSSH installed?", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .collect();

    if lines.is_empty() {
        let hint = if stderr.to_lowercase().contains("no route to host")
            || stderr.to_lowercase().contains("timed out")
            || stderr.to_lowercase().contains("connection refused")
        {
            stderr.trim().to_string()
        } else {
            format!("ssh-keyscan returned no keys for {}:{}", host, port)
        };
        return Err(hint);
    }

    let mut results: Vec<HostKey> = Vec::with_capacity(lines.len());
    for line in &lines {
        // Each line looks like: `<host>[:port] <algorithm> <base64-key>`.
        // Extract algorithm for the result struct (frontend displays it
        // alongside the fingerprint).
        let mut parts = line.split_whitespace();
        let _host_part = parts.next();
        let algorithm = parts
            .next()
            .unwrap_or_else(|| {
                // Malformed keyscan line — empty alg is harmless downstream but useful to flag.
                warn!(line = %line, "ssh-keyscan line missing algorithm token");
                ""
            })
            .to_string();

        // Derive the SHA256 fingerprint by piping the keyscan line to
        // `ssh-keygen -lf -`. Output: "<bits> SHA256:<...> <comment> (<alg>)".
        let mut keygen = tokio::process::Command::new("ssh-keygen");
        keygen.arg("-l").arg("-f").arg("-");
        keygen.stdin(Stdio::piped());
        keygen.stdout(Stdio::piped());
        keygen.stderr(Stdio::piped());

        let mut child = keygen
            .spawn()
            .map_err(|e| format!("Failed to spawn ssh-keygen: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
        }
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| format!("ssh-keygen failed: {}", e))?;

        let fp_line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Pluck the SHA256:<...> token out of the keygen output.
        let fingerprint = fp_line
            .split_whitespace()
            .find(|tok| tok.starts_with("SHA256:"))
            .unwrap_or_else(|| {
                // ssh-keygen output format changed or input was rejected — empty fingerprint
                // gets filtered out below, but the cause is otherwise invisible.
                warn!(keygen_output = %fp_line, "ssh-keygen output missing SHA256 token");
                ""
            })
            .to_string();

        if !fingerprint.is_empty() {
            results.push(HostKey {
                algorithm,
                key: line.to_string(),
                fingerprint,
            });
        }
    }

    if results.is_empty() {
        return Err("Failed to derive SHA256 fingerprints from ssh-keyscan output".to_string());
    }
    Ok(results)
}

/// Append a `known_hosts`-format line to the app-managed file. Idempotent:
/// duplicate lines are skipped. Called by the Servers UI after the user
/// confirms the fingerprint shown by `ssh_fetch_fingerprint`.
#[tauri::command]
pub fn ssh_pin_host(host: String, port: u16, hostkey_line: String) -> Result<(), String> {
    use std::io::BufRead;

    let _ = (host, port); // host/port already encoded in the keyscan line
    let trimmed = hostkey_line.trim();
    if trimmed.is_empty() {
        return Err("Empty host key line".to_string());
    }

    let path = crate::core::execution::ensure_known_hosts_dir()?;
    // De-dupe: skip if the exact line already exists.
    if path.exists() {
        if let Ok(file) = std::fs::File::open(&path) {
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                if line.trim() == trimmed {
                    return Ok(());
                }
            }
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open {:?}: {}", path, e))?;
    use std::io::Write;
    writeln!(file, "{}", trimmed).map_err(|e| format!("Failed to write known_hosts: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Return the absolute path of the app-managed `known_hosts` file. The
/// frontend fetches this once at startup and passes it into
/// `buildSshArgs` so JS-side SSH invocations match the Rust-side pinning.
#[tauri::command]
pub fn get_app_known_hosts_path() -> Result<String, String> {
    let path = crate::core::execution::ensure_known_hosts_dir()?;
    Ok(path.to_string_lossy().to_string())
}

/// Result of probing a remote filesystem path over SSH.
///
/// Used by the workspace creation modal to validate that the user-supplied
/// remote project path exists and is a directory before persisting a new
/// remote workspace. `is_git_repo` is a hint shown next to the path field.
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathCheck {
    pub exists: bool,
    pub is_directory: bool,
    pub is_git_repo: bool,
}

fn resolve_remote_probe_password(
    auth_method: &str,
    supplied_password: Option<String>,
    target_id: Option<&str>,
    load_saved: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    if auth_method != "password" {
        return Ok(None);
    }
    if let Some(password) = supplied_password.filter(|value| !value.is_empty()) {
        return Ok(Some(password));
    }
    let target_id = target_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Password authentication requires a saved server target id".to_string())?;
    load_saved(target_id)?
        .ok_or_else(|| {
            "No saved SSH password is available for this server. Re-save it in Servers settings."
                .to_string()
        })
        .map(Some)
}

/// Probe a remote SSH host to determine whether `remote_path` exists, is a
/// directory, and contains a `.git` directory. Used by the workspace
/// creation modal for live validation of the "Remote project path" input.
///
/// Times out after 8 seconds. Host-key pinning: when `host_fingerprint` is
/// `Some` we use the app-managed `known_hosts` file with
/// `StrictHostKeyChecking=yes`;
/// otherwise we fall back to TOFU `accept-new`. Callers that care about
/// safety should require a verified fingerprint before invoking this.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_check_remote_path(
    host: String,
    port: u16,
    user: String,
    target_id: Option<String>,
    auth_method: String,
    key_path: Option<String>,
    password: Option<String>,
    host_fingerprint: Option<String>,
    remote_path: String,
) -> Result<RemotePathCheck, String> {
    if remote_path.trim().is_empty() {
        return Err("Remote path is empty".to_string());
    }

    let mut args: Vec<String> = vec![
        "-p".to_string(),
        port.to_string(),
        "-o".to_string(),
        "ConnectTimeout=8".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=1".to_string(),
    ];

    if host_fingerprint.is_some() {
        let kh = crate::core::execution::app_known_hosts_path();
        args.push("-o".to_string());
        args.push("StrictHostKeyChecking=yes".to_string());
        args.push("-o".to_string());
        args.push(format!("UserKnownHostsFile={}", kh.to_string_lossy()));
    } else {
        tracing::warn!(
            host = %host,
            port = %port,
            "ssh_check_remote_path without pinned fingerprint — TOFU fallback"
        );
        args.push("-o".to_string());
        args.push("StrictHostKeyChecking=accept-new".to_string());
    }

    // Auth heuristics: if we have a
    // password to pipe to stdin, allow interactive password auth;
    // otherwise require key-only / BatchMode so SSH cannot hang.
    let pw_in = resolve_remote_probe_password(
        &auth_method,
        password,
        target_id.as_deref(),
        crate::commands::ssh_keys::load_ssh_password,
    )?;
    if pw_in.is_none() {
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

    let quoted = crate::core::execution::sh_quote(&remote_path);
    // Single-line POSIX shell probe — emits exactly one of:
    //   DIR_GIT | DIR | FILE | MISSING
    let probe = format!(
        "P={}; if [ -e \"$P\" ]; then if [ -d \"$P\" ]; then if [ -d \"$P/.git\" ]; then echo DIR_GIT; else echo DIR; fi; else echo FILE; fi; else echo MISSING; fi",
        quoted
    );
    args.push(probe);

    // Enforce an outer timeout in case SSH itself hangs despite ConnectTimeout.
    let fut = ssh_exec(args, pw_in);
    let output = match tokio::time::timeout(std::time::Duration::from_secs(8), fut).await {
        Ok(res) => res?,
        Err(_) => return Err("Probe timed out after 8s".to_string()),
    };

    let trimmed = output.trim();
    // Walk lines from the end — the probe's echo is always last; earlier
    // lines may contain SSH banners / motd noise.
    let tag = trimmed.lines().rev().find_map(|line| {
        let t = line.trim();
        match t {
            "DIR_GIT" | "DIR" | "FILE" | "MISSING" => Some(t),
            _ => None,
        }
    });

    match tag {
        Some("DIR_GIT") => Ok(RemotePathCheck {
            exists: true,
            is_directory: true,
            is_git_repo: true,
        }),
        Some("DIR") => Ok(RemotePathCheck {
            exists: true,
            is_directory: true,
            is_git_repo: false,
        }),
        Some("FILE") => Ok(RemotePathCheck {
            exists: true,
            is_directory: false,
            is_git_repo: false,
        }),
        Some("MISSING") => Ok(RemotePathCheck {
            exists: false,
            is_directory: false,
            is_git_repo: false,
        }),
        _ => {
            let lower = trimmed.to_lowercase();
            let msg =
                if lower.contains("permission denied") || lower.contains("authentication failed") {
                    "Authentication failed — verify the server credentials."
                } else if lower.contains("could not resolve")
                    || lower.contains("name or service not known")
                {
                    "Could not resolve host."
                } else if lower.contains("connection refused") {
                    "Connection refused."
                } else if lower.contains("connection timed out")
                    || lower.contains("operation timed out")
                {
                    "Connection timed out."
                } else if lower.contains("host key verification failed") {
                    "Host key verification failed — re-pin the host key on the Servers page."
                } else if trimmed.is_empty() {
                    "SSH returned no output."
                } else {
                    return Err(trimmed.to_string());
                };
            Err(msg.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::ExitStatus;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Debug)]
    struct FakeKiller {
        killed: Arc<AtomicBool>,
    }

    impl PtyChildKiller for FakeKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn PtyChildKiller + Send + Sync> {
            Box::new(Self {
                killed: self.killed.clone(),
            })
        }
    }

    #[derive(Debug)]
    struct FakeChild {
        exited: Arc<AtomicBool>,
        try_wait_calls: Arc<AtomicUsize>,
    }

    impl PtyChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.exited.store(true, Ordering::Relaxed);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn PtyChildKiller + Send + Sync> {
            Box::new(FakeKiller {
                killed: self.exited.clone(),
            })
        }
    }

    impl PtyChild for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            self.try_wait_calls.fetch_add(1, Ordering::Relaxed);
            if self.exited.load(Ordering::Relaxed) {
                Ok(Some(ExitStatus::with_exit_code(7)))
            } else {
                Ok(None)
            }
        }

        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(7))
        }

        fn process_id(&self) -> Option<u32> {
            Some(123)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn shared_fake_child(exited: bool) -> (SharedChild, Arc<AtomicUsize>) {
        let try_wait_calls = Arc::new(AtomicUsize::new(0));
        let child = FakeChild {
            exited: Arc::new(AtomicBool::new(exited)),
            try_wait_calls: try_wait_calls.clone(),
        };
        (Arc::new(Mutex::new(Box::new(child))), try_wait_calls)
    }

    #[test]
    fn pty_exit_payload_serializes_exit_code_and_terminated() {
        let payload = PtyExitPayload {
            session_id: "session-1".to_string(),
            exit_code: Some(42),
            terminated: true,
        };

        let value = serde_json::to_value(payload).expect("serialize payload");

        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["exitCode"], 42);
        assert_eq!(value["terminated"], true);
    }

    #[test]
    fn terminal_pty_read_error_detects_broken_pipe_and_eio() {
        let broken = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broken pipe");
        assert!(is_terminal_pty_read_error(&broken));

        let eio = std::io::Error::from_raw_os_error(5);
        assert!(is_terminal_pty_read_error(&eio));
    }

    #[test]
    fn signal_pty_kill_marks_orchestrator_terminated_and_uses_killer() {
        let kill_flag = AtomicBool::new(false);
        let orchestrator_killed = AtomicBool::new(false);
        let killed = Arc::new(AtomicBool::new(false));
        let killer: SharedChildKiller = Arc::new(Mutex::new(Box::new(FakeKiller {
            killed: killed.clone(),
        })));

        signal_pty_kill("session-1", &kill_flag, Some(&orchestrator_killed), &killer)
            .expect("signal kill");

        assert!(kill_flag.load(Ordering::Relaxed));
        assert!(orchestrator_killed.load(Ordering::Relaxed));
        assert!(killed.load(Ordering::Relaxed));
    }

    #[test]
    fn wait_for_pty_child_exit_reports_completed_child() {
        let (child, try_wait_calls) = shared_fake_child(true);

        assert!(wait_for_pty_child_exit(
            "session-1",
            &child,
            std::time::Duration::from_millis(50),
        ));
        assert_eq!(try_wait_calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn wait_for_pty_child_exit_times_out_when_reader_holds_child_lock() {
        let (child, try_wait_calls) = shared_fake_child(false);
        let _reader_wait_guard = child.lock().expect("lock child");

        assert!(!wait_for_pty_child_exit(
            "session-1",
            &child,
            std::time::Duration::from_millis(5),
        ));
        assert_eq!(try_wait_calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn remote_probe_resolves_saved_password_by_target_id() {
        let password =
            resolve_remote_probe_password("password", None, Some("server-1"), |target| {
                assert_eq!(target, "server-1");
                Ok(Some("secret".to_string()))
            })
            .unwrap();

        assert_eq!(password.as_deref(), Some("secret"));
    }

    #[test]
    fn remote_probe_never_loads_password_for_key_auth() {
        let password = resolve_remote_probe_password("key", None, Some("server-1"), |_| {
            panic!("saved password loader must not run for key auth")
        })
        .unwrap();

        assert!(password.is_none());
    }

    #[test]
    fn remote_probe_reports_missing_saved_password() {
        let error = resolve_remote_probe_password("password", None, Some("server-1"), |_| Ok(None))
            .unwrap_err();

        assert!(error.contains("No saved SSH password"));
    }

    #[test]
    fn windows_command_lookup_fallback_preserves_requested_name() {
        assert_eq!(
            windows_command_lookup_fallback("missing-cli"),
            "missing-cli"
        );
        assert_eq!(windows_command_lookup_fallback("custom.exe"), "custom.exe");
    }
}
