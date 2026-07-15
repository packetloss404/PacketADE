use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tracing::{info, warn};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use uuid::Uuid;

use super::shared::MAX_PTY_WRITE_SIZE;
use super::storage;

/// Resolve a command name to its actual path, preferring .exe over .cmd on Windows.
fn resolve_command_path(command: &str) -> String {
    #[cfg(windows)]
    {
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
                if let Some(exe) = lines.iter().find(|l| l.ends_with(".exe")) {
                    return exe.to_string();
                }
                if let Some(cmd_file) = lines.iter().find(|l| l.ends_with(".cmd")) {
                    return cmd_file.to_string();
                }
                if let Some(first) = lines.first() {
                    return first.to_string();
                }
            }
        }
        format!("{}.cmd", command)
    }
    #[cfg(not(windows))]
    {
        command.to_string()
    }
}

const PTY_TRANSCRIPT_LIMIT_BYTES: usize = 256 * 1024;
static PTY_TRANSCRIPT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn decode_terminal_chunk(bytes: &[u8], pending: &mut Vec<u8>) -> String {
    // Combine any buffered bytes with the new chunk. Taking `pending` by value
    // avoids aliasing so we can freely reassign it at the end.
    let combined: Vec<u8> = if pending.is_empty() {
        bytes.to_vec()
    } else {
        let mut v = std::mem::take(pending);
        v.extend_from_slice(bytes);
        v
    };

    // Incrementally decode. Only a trailing *incomplete* multibyte sequence is
    // buffered for the next chunk (`error_len() == None`). A genuinely INVALID
    // byte (`error_len() == Some(n)`) is emitted as U+FFFD and skipped — F02: the
    // old code buffered it instead, so one bad byte re-queued forever and the
    // terminal's `pending` grew without bound, freezing output.
    let mut out = String::new();
    let mut i = 0usize;
    let leftover: Vec<u8> = loop {
        match std::str::from_utf8(&combined[i..]) {
            Ok(s) => {
                out.push_str(s);
                break Vec::new();
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // `combined[i..i+valid]` is valid UTF-8 by definition.
                out.push_str(&String::from_utf8_lossy(&combined[i..i + valid]));
                match e.error_len() {
                    None => break combined[i + valid..].to_vec(),
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        i += valid + bad;
                    }
                }
            }
        }
    };

    *pending = leftover;
    out
}

/// Events emitted by PTY sessions via channels
#[derive(Clone, Debug)]
pub enum PtyEvent {
    /// New output data from a session
    Output { session_id: String, data: String },
    /// Session has exited
    Exit {
        session_id: String,
        exit_code: Option<i32>,
        success: bool,
        killed: bool,
    },
}

/// Info about a running PTY session
#[derive(Clone, Serialize, Debug)]
pub struct PtySessionInfo {
    pub id: String,
    pub project_path: String,
    pub pid: Option<u32>,
    pub alive: bool,
}

#[derive(Clone, Serialize, Debug)]
pub struct PtyTranscript {
    pub session_id: String,
    pub data: String,
    pub truncated: bool,
}

/// Internal state for one PTY session
struct PtySession {
    info: PtySessionInfo,
    killer: Box<dyn ChildKiller + Send + Sync>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    kill_flag: Arc<std::sync::atomic::AtomicBool>,
}

/// Framework-agnostic PTY session manager.
/// Output is delivered via an mpsc channel instead of Tauri events.
pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
    event_tx: mpsc::Sender<PtyEvent>,
}

impl PtyManager {
    pub fn new(event_tx: mpsc::Sender<PtyEvent>) -> Self {
        Self {
            sessions: HashMap::new(),
            event_tx,
        }
    }

    /// Create a new PTY session. Returns the session ID.
    pub fn create_session(
        &mut self,
        project_path: &str,
        cols: u16,
        rows: u16,
        command: &str,
        args: &[String],
    ) -> Result<String, String> {
        let project_dir = std::path::Path::new(project_path);
        if !project_dir.is_dir() {
            return Err(format!(
                "Project path '{}' is not a valid directory",
                project_path
            ));
        }

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

        // Resolve command on Windows — prefer .exe over .cmd
        let resolved_command = resolve_command_path(command);
        let mut cmd = if cfg!(windows) && resolved_command.ends_with(".cmd") {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(&["/c", &resolved_command]);
            c
        } else {
            CommandBuilder::new(&resolved_command)
        };
        cmd.cwd(project_path);

        for arg in args {
            cmd.arg(arg);
        }

        // Claude-specific env
        if command == "claude" {
            cmd.env_remove("CLAUDECODE");
            cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
            cmd.env("FLIGHTDECK", "1");
        }

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            format!(
                "Failed to spawn {} in PTY: {}. Is {} installed?",
                command, e, command
            )
        })?;

        let pid = child.process_id();
        // Record the pid so a crash/force-quit that can't run cleanup gets swept
        // on the next launch (see `reap_orphaned_pty_children`).
        if let Some(pid) = pid {
            record_spawned_pid(pid, &command);
        }
        let killer = child.clone_killer();

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
            project_path: project_path.to_string(),
            pid,
            alive: true,
        };

        if let Some(path) = transcript_path(&session_id) {
            if let Err(e) = fs::write(&path, "") {
                tracing::warn!(error = %e, ?path, "failed to initialize PTY transcript file");
            }
        }
        if let Some(path) = transcript_truncated_marker_path(&session_id) {
            let _ = fs::remove_file(path);
        }

        let session = PtySession {
            info: info.clone(),
            killer,
            writer,
            master: pair.master,
            kill_flag: kill_flag.clone(),
        };

        self.sessions.insert(session_id.clone(), session);

        // Spawn output reader thread
        let output_sid = session_id.clone();
        let output_tx = self.event_tx.clone();
        let output_kill_flag = kill_flag.clone();

        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                if output_kill_flag.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }

                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = decode_terminal_chunk(&buf[..n], &mut pending);
                        append_transcript(&output_sid, &data);
                        let _ = output_tx.send(PtyEvent::Output {
                            session_id: output_sid.clone(),
                            data,
                        });
                    }
                    Err(e) => {
                        let err_str = e.to_string();
                        if err_str.contains("broken pipe")
                            || err_str.contains("The pipe has been ended")
                            || e.kind() == std::io::ErrorKind::BrokenPipe
                        {
                            break;
                        }
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
            }
        });

        let wait_sid = session_id.clone();
        let wait_tx = self.event_tx.clone();
        let wait_kill_flag = kill_flag;

        thread::spawn(move || {
            let wait_result = child.wait();
            let killed = wait_kill_flag.load(std::sync::atomic::Ordering::Relaxed);

            let (exit_code, success) = match wait_result {
                Ok(status) => {
                    let exit_code = Some(status.exit_code() as i32);
                    (exit_code, status.success() && !killed)
                }
                Err(e) => {
                    warn!(session_id = %wait_sid, error = %e, "Failed waiting for PTY child exit");
                    (None, false)
                }
            };

            info!(session_id = %wait_sid, exit_code = ?exit_code, killed, success, "PTY session exited");
            let _ = wait_tx.send(PtyEvent::Exit {
                session_id: wait_sid,
                exit_code,
                success,
                killed,
            });
        });

        Ok(session_id)
    }

    /// Write data to a PTY session's stdin.
    pub fn write(&mut self, session_id: &str, data: &str) -> Result<(), String> {
        if data.len() > MAX_PTY_WRITE_SIZE {
            return Err(format!(
                "PTY write data exceeds max size ({} bytes, limit {})",
                data.len(),
                MAX_PTY_WRITE_SIZE
            ));
        }

        let session = self
            .sessions
            .get_mut(session_id)
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

    /// Resize a PTY session.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
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

    /// Kill a PTY session.
    ///
    /// Reaps the entire process GROUP, not just the direct child. The PTY spawn
    /// helper `setsid`s each child into its own session/group, so the child pid
    /// is the group leader and `kill(-pid, …)` signals every descendant it
    /// spawned. Without the group kill, workers a CLI agent forks (e.g. an
    /// `opencode`/`codex` agent's sub-processes, or a wrapped shell's child)
    /// survive pane close, reparent to launchd, and spin at 100% CPU forever —
    /// which is exactly how a machine ends up with a pile of orphaned agents.
    pub fn kill(&mut self, session_id: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.get_mut(session_id) {
            info!(session_id = %session_id, "Killing PTY session");
            session
                .kill_flag
                .store(true, std::sync::atomic::Ordering::Relaxed);
            session.info.alive = false;

            #[cfg(unix)]
            {
                // Collect the groups to reap: the setsid leader's group (child
                // pid == pgid) plus the terminal's current foreground group, in
                // case job control moved the running command into a distinct one.
                let mut groups: Vec<libc::pid_t> = Vec::new();
                if let Some(pid) = session.info.pid {
                    groups.push(pid as libc::pid_t);
                }
                if let Some(fg) = session.master.process_group_leader() {
                    if !groups.contains(&fg) {
                        groups.push(fg);
                    }
                }
                for gid in groups {
                    // Guard against 0/1 (would broadcast to our own group / init).
                    if gid > 1 {
                        // SIGTERM the group for a chance to unwind, then SIGKILL
                        // to guarantee the reap. Negative pid = whole group.
                        unsafe {
                            libc::kill(-gid, libc::SIGTERM);
                            libc::kill(-gid, libc::SIGKILL);
                        }
                    }
                }
            }

            // Still kill the direct child via portable-pty (handles non-unix and
            // is a harmless no-op if the group kill already reaped it).
            if let Err(e) = session.killer.kill() {
                warn!(session_id = %session_id, error = %e, "Failed to kill PTY child");
            }
            Ok(())
        } else {
            Err(format!("PTY session {} not found", session_id))
        }
    }

    /// Kill a PTY session and wait for the exit event (with timeout).
    /// Returns Ok(true) if the session exited, Ok(false) if it timed out.
    pub fn kill_and_wait(
        &mut self,
        session_id: &str,
        timeout: std::time::Duration,
    ) -> Result<bool, String> {
        self.kill(session_id)?;
        // We can't block on the mpsc channel here since we don't own the receiver.
        // Instead, poll the session's kill_flag and check if the session was removed.
        let start = std::time::Instant::now();
        let sid = session_id.to_string();
        loop {
            if !self.sessions.contains_key(&sid) {
                return Ok(true);
            }
            if start.elapsed() >= timeout {
                warn!(session_id = %sid, "PTY kill timed out after {:?}", timeout);
                // Force remove the session even if it didn't exit cleanly
                self.sessions.remove(&sid);
                return Ok(false);
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Kill multiple sessions and wait for all to exit.
    pub fn kill_sessions_and_wait(
        &mut self,
        session_ids: &[String],
        timeout: std::time::Duration,
    ) -> Vec<(String, bool)> {
        // First, send kill signal to all sessions
        for sid in session_ids {
            let _ = self.kill(sid);
        }
        // Then wait for all to exit
        let start = std::time::Instant::now();
        let mut results = Vec::new();
        for sid in session_ids {
            let exited = loop {
                if !self.sessions.contains_key(sid) {
                    break true;
                }
                if start.elapsed() >= timeout {
                    self.sessions.remove(sid);
                    break false;
                }
                thread::sleep(std::time::Duration::from_millis(50));
            };
            results.push((sid.clone(), exited));
        }
        results
    }

    /// List all active sessions.
    pub fn list(&self) -> Vec<PtySessionInfo> {
        self.sessions.values().map(|s| s.info.clone()).collect()
    }

    /// Remove a session from tracking (called when output thread detects exit).
    pub fn remove_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }
}

pub fn read_transcript(session_id: &str) -> Result<PtyTranscript, String> {
    let path = transcript_path(session_id)
        .ok_or_else(|| "Unable to resolve transcript path".to_string())?;

    let lock = PTY_TRANSCRIPT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| "PTY transcript lock poisoned".to_string())?;

    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("Failed to read PTY transcript: {}", e)),
    };

    let marker_exists = transcript_truncated_marker_path(session_id)
        .map(|path| path.exists())
        .unwrap_or(false);
    let truncated = marker_exists || bytes.len() > PTY_TRANSCRIPT_LIMIT_BYTES;
    let relevant = if truncated {
        &bytes[bytes.len().saturating_sub(PTY_TRANSCRIPT_LIMIT_BYTES)..]
    } else {
        &bytes[..]
    };

    Ok(PtyTranscript {
        session_id: session_id.to_string(),
        data: String::from_utf8_lossy(relevant).to_string(),
        truncated,
    })
}

fn transcript_path(session_id: &str) -> Option<PathBuf> {
    // Validate session_id is a valid UUID to prevent path traversal
    if uuid::Uuid::parse_str(session_id).is_err() {
        return None;
    }
    let dir = storage::data_dir().join("pty-transcripts");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join(format!("{}.log", session_id)))
}

fn transcript_truncated_marker_path(session_id: &str) -> Option<PathBuf> {
    transcript_path(session_id).map(|path| path.with_extension("log.truncated"))
}

/// Registry of PIDs for PTY children spawned this run. One line per child:
/// `<pid>\t<command-basename>`. Consumed by `reap_orphaned_pty_children` on the
/// NEXT launch to kill any child that survived an abnormal exit (SIGKILL /
/// crash / force-quit) — those reparent to launchd and otherwise spin at 100%
/// CPU forever. Clean pane-close already reaps via `kill()`'s group signal; this
/// is the safety net for exits that can't run cleanup.
fn pty_pids_registry_path() -> PathBuf {
    storage::data_dir().join("pty-active-pids")
}

/// Append a freshly-spawned PTY child pid + its command basename to the registry.
fn record_spawned_pid(pid: u32, command: &str) {
    let basename = std::path::Path::new(command)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(command);
    let path = pty_pids_registry_path();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}\t{}", pid, basename);
    }
}

/// Startup sweep: reap any PTY children recorded by a previous run that are
/// still alive. Before signalling, verify the pid's current command basename
/// still matches what we recorded — so a recycled pid (now some unrelated
/// process) is never killed. Signals the whole process GROUP (`kill(-pid)`),
/// since each PTY child is a `setsid` session leader. Truncates the registry
/// afterward; sessions spawned this run re-append as they start.
#[cfg(unix)]
pub fn reap_orphaned_pty_children() {
    let path = pty_pids_registry_path();
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut reaped = 0usize;
    for line in contents.lines() {
        let mut parts = line.splitn(2, '\t');
        let pid: i32 = match parts.next().and_then(|p| p.trim().parse().ok()) {
            Some(p) if p > 1 => p,
            _ => continue,
        };
        let recorded = parts.next().unwrap_or("").trim();
        if recorded.is_empty() {
            continue;
        }
        // Verify pid is alive AND still running the recorded command basename.
        let matches = std::process::Command::new("ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| {
                let name = String::from_utf8_lossy(&out.stdout);
                let name = name.trim();
                let base = std::path::Path::new(name)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(name);
                base == recorded
            })
            .unwrap_or(false);
        if matches {
            // SIGTERM the group for a chance to unwind, then SIGKILL to guarantee.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
                libc::kill(-pid, libc::SIGKILL);
            }
            reaped += 1;
        }
    }
    if reaped > 0 {
        warn!(
            count = reaped,
            "Reaped orphaned PTY children left by a previous run"
        );
    }
    // Clear the registry regardless — dead/mismatched entries are done with.
    let _ = fs::write(&path, "");
}

#[cfg(not(unix))]
pub fn reap_orphaned_pty_children() {}

fn mark_transcript_truncated(session_id: &str) {
    if let Some(path) = transcript_truncated_marker_path(session_id) {
        let _ = fs::write(path, b"truncated\n");
    }
}

pub(crate) fn append_transcript(session_id: &str, data: &str) {
    let Some(path) = transcript_path(session_id) else {
        return;
    };

    let lock = PTY_TRANSCRIPT_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };

    let incoming = data.as_bytes();
    let existing_len = fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0);
    if incoming.len() >= PTY_TRANSCRIPT_LIMIT_BYTES {
        let start = incoming.len() - PTY_TRANSCRIPT_LIMIT_BYTES;
        let _ = fs::write(&path, &incoming[start..]);
        if incoming.len() > PTY_TRANSCRIPT_LIMIT_BYTES || existing_len > 0 {
            mark_transcript_truncated(session_id);
        }
        return;
    }

    if existing_len + incoming.len() <= PTY_TRANSCRIPT_LIMIT_BYTES {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(incoming);
        }
        return;
    }

    let existing = fs::read(&path).unwrap_or_default();
    let keep_existing = PTY_TRANSCRIPT_LIMIT_BYTES.saturating_sub(incoming.len());
    let start = existing.len().saturating_sub(keep_existing);
    let mut bounded = Vec::with_capacity(PTY_TRANSCRIPT_LIMIT_BYTES);
    bounded.extend_from_slice(&existing[start..]);
    bounded.extend_from_slice(incoming);
    let _ = fs::write(&path, bounded);
    mark_transcript_truncated(session_id);
}

/// Thread-safe wrapper
pub type SharedPtyManager = Arc<Mutex<PtyManager>>;

pub fn create_shared_pty_manager(event_tx: mpsc::Sender<PtyEvent>) -> SharedPtyManager {
    Arc::new(Mutex::new(PtyManager::new(event_tx)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_path_rejects_traversal_attack() {
        assert!(transcript_path("../../etc/passwd").is_none());
    }

    #[test]
    fn transcript_path_rejects_non_uuid() {
        assert!(transcript_path("not-a-uuid").is_none());
        assert!(transcript_path("").is_none());
        assert!(transcript_path("hello world").is_none());
    }

    #[test]
    fn transcript_path_accepts_valid_uuid() {
        let id = uuid::Uuid::new_v4().to_string();
        let path = transcript_path(&id);
        assert!(path.is_some());
        assert!(path.unwrap().to_string_lossy().contains(&id));
    }

    #[test]
    fn decode_terminal_chunk_preserves_ansi_sequences() {
        let mut pending = Vec::new();

        let data = decode_terminal_chunk(b"\x1b[31mred\x1b[0m\r\n", &mut pending);

        assert_eq!(data, "\x1b[31mred\x1b[0m\r\n");
        assert!(pending.is_empty());
    }

    #[test]
    fn decode_terminal_chunk_buffers_split_utf8_sequences() {
        let mut pending = Vec::new();

        let first = decode_terminal_chunk(&[0xE2, 0x94], &mut pending);
        let second = decode_terminal_chunk(&[0x82, b'\n'], &mut pending);

        assert_eq!(first, "");
        assert_eq!(second, "│\n");
        assert!(pending.is_empty());
    }

    #[test]
    fn decode_terminal_chunk_does_not_rewrite_plain_text() {
        let mut pending = Vec::new();

        let data = decode_terminal_chunk("Claude Code for Cursor".as_bytes(), &mut pending);

        assert_eq!(data, "Claude Code for Cursor");
        assert!(pending.is_empty());
    }

    #[test]
    fn decode_terminal_chunk_flushes_invalid_bytes_without_wedging() {
        // F02: an invalid byte must be emitted as U+FFFD and NOT buffered, or it
        // re-queues forever and freezes the terminal.
        let mut pending = Vec::new();
        let data = decode_terminal_chunk(b"\xffhello", &mut pending);
        assert_eq!(data, "\u{FFFD}hello");
        assert!(pending.is_empty(), "invalid byte must not be buffered");

        // A flood of invalid bytes across many chunks must not accumulate.
        for _ in 0..1000 {
            let out = decode_terminal_chunk(b"\xff", &mut pending);
            assert_eq!(out, "\u{FFFD}");
        }
        assert!(pending.is_empty(), "pending must stay bounded on invalid input");
    }

    #[test]
    fn decode_terminal_chunk_handles_invalid_then_incomplete() {
        // An invalid byte followed by a split multibyte sequence: the bad byte is
        // flushed, and only the incomplete tail is buffered.
        let mut pending = Vec::new();
        let first = decode_terminal_chunk(&[0xff, 0xE2, 0x94], &mut pending);
        assert_eq!(first, "\u{FFFD}");
        let second = decode_terminal_chunk(&[0x82, b'\n'], &mut pending);
        assert_eq!(second, "│\n");
        assert!(pending.is_empty());
    }

    fn cleanup_transcript_files(session_id: &str) {
        if let Some(path) = transcript_path(session_id) {
            let _ = std::fs::remove_file(path);
        }
        if let Some(path) = transcript_truncated_marker_path(session_id) {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn read_transcript_reports_truncated_after_bounded_append_discards_history() {
        let id = uuid::Uuid::new_v4().to_string();
        cleanup_transcript_files(&id);

        append_transcript(&id, &"a".repeat(PTY_TRANSCRIPT_LIMIT_BYTES - 4));
        append_transcript(&id, "bbbbbbbb");

        let transcript = read_transcript(&id).expect("read transcript");
        assert!(transcript.truncated);
        assert_eq!(transcript.data.len(), PTY_TRANSCRIPT_LIMIT_BYTES);
        assert!(transcript.data.ends_with("bbbbbbbb"));

        cleanup_transcript_files(&id);
    }
}
