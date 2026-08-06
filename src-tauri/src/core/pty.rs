//! PTY transcript persistence and the cross-run orphan registry.
//!
//! The live PTY session manager is `commands::pty` — the single owner of
//! spawning, killing, and Tauri event emission. This module used to carry a
//! second, channel-based `PtyManager` that nothing ever constructed; the
//! startup reaper below read a pid registry only that dead manager wrote, so it
//! reaped nothing for its entire lifetime. It was removed rather than revived,
//! and `commands::pty` now writes the registry directly.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::storage;

const PTY_TRANSCRIPT_LIMIT_BYTES: usize = 256 * 1024;
static PTY_TRANSCRIPT_SEQUENCES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

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

#[derive(Clone, Serialize, Debug)]
pub struct PtyTranscript {
    pub session_id: String,
    pub data: String,
    pub truncated: bool,
    /// Sequence of the newest output record included in `data`.
    pub sequence: u64,
}

pub fn read_transcript(session_id: &str) -> Result<PtyTranscript, String> {
    let path = transcript_path(session_id)
        .ok_or_else(|| "Unable to resolve transcript path".to_string())?;

    let state = PTY_TRANSCRIPT_SEQUENCES.get_or_init(|| Mutex::new(HashMap::new()));
    let sequences = state
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
        sequence: sequences.get(session_id).copied().unwrap_or(0),
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
/// CPU forever. Pane close and app exit already reap through
/// `commands::pty::kill_pty_process_tree`; this is the safety net for exits
/// that can't run cleanup.
fn pty_pids_registry_path() -> PathBuf {
    storage::data_dir().join("pty-active-pids")
}

/// Append a freshly-spawned PTY child pid + its command basename to the
/// registry. Called by `commands::pty::create_pty_session` immediately after
/// the spawn reports a pid.
pub(crate) fn record_spawned_pid(pid: u32, command: &str) {
    let path = pty_pids_registry_path();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", registry_line(pid, command));
    }
}

/// One registry record: pid + the basename of the image the child actually
/// runs. The basename is what `reap_orphaned_pty_children` matches against the
/// live process, so a recycled pid can never be mistaken for ours.
fn registry_line(pid: u32, command: &str) -> String {
    let basename = std::path::Path::new(command)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(command);
    format!("{}\t{}", pid, basename)
}

/// Inverse of [`registry_line`]. Rejects pids that would signal our own group
/// (`0`) or init (`1`), and records with no recorded image name.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_registry_line(line: &str) -> Option<(i32, String)> {
    let mut parts = line.splitn(2, '\t');
    let pid: i32 = parts.next()?.trim().parse().ok().filter(|p| *p > 1)?;
    let recorded = parts.next()?.trim();
    if recorded.is_empty() {
        return None;
    }
    Some((pid, recorded.to_string()))
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
        let Some((pid, recorded)) = parse_registry_line(line) else {
            continue;
        };
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
        tracing::warn!(
            count = reaped,
            "Reaped orphaned PTY children left by a previous run"
        );
    }
    // Clear the registry regardless — dead/mismatched entries are done with.
    let _ = fs::write(&path, "");
}

/// Windows has no cross-run sweep. The identity check that makes the Unix
/// sweep safe does not carry over: a `.cmd`-wrapped CLI's direct child is
/// `cmd.exe`, so a recycled pid would match the recorded image name and we
/// would tree-kill an unrelated console. Pane close and the app-exit handler
/// still reap via `taskkill /T /F`; only a hard crash can strand a child here.
/// The registry is still cleared so it cannot grow without bound.
#[cfg(not(unix))]
pub fn reap_orphaned_pty_children() {
    let _ = fs::write(pty_pids_registry_path(), "");
}

fn mark_transcript_truncated(session_id: &str) {
    if let Some(path) = transcript_truncated_marker_path(session_id) {
        let _ = fs::write(path, b"truncated\n");
    }
}

pub(crate) fn append_transcript(session_id: &str, data: &str) -> u64 {
    let Some(path) = transcript_path(session_id) else {
        return 0;
    };

    let state = PTY_TRANSCRIPT_SEQUENCES.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut sequences) = state.lock() else {
        return 0;
    };
    let sequence = sequences
        .entry(session_id.to_string())
        .and_modify(|value| *value = value.saturating_add(1))
        .or_insert(1)
        .to_owned();

    let incoming = data.as_bytes();
    let existing_len = fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0);
    if incoming.len() >= PTY_TRANSCRIPT_LIMIT_BYTES {
        let start = incoming.len() - PTY_TRANSCRIPT_LIMIT_BYTES;
        let _ = fs::write(&path, &incoming[start..]);
        if incoming.len() > PTY_TRANSCRIPT_LIMIT_BYTES || existing_len > 0 {
            mark_transcript_truncated(session_id);
        }
        return sequence;
    }

    if existing_len + incoming.len() <= PTY_TRANSCRIPT_LIMIT_BYTES {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(incoming);
        }
        return sequence;
    }

    let existing = fs::read(&path).unwrap_or_default();
    let keep_existing = PTY_TRANSCRIPT_LIMIT_BYTES.saturating_sub(incoming.len());
    let start = existing.len().saturating_sub(keep_existing);
    let mut bounded = Vec::with_capacity(PTY_TRANSCRIPT_LIMIT_BYTES);
    bounded.extend_from_slice(&existing[start..]);
    bounded.extend_from_slice(incoming);
    let _ = fs::write(&path, bounded);
    mark_transcript_truncated(session_id);
    sequence
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_line_records_the_spawned_image_basename() {
        assert_eq!(registry_line(4242, "/usr/local/bin/claude"), "4242\tclaude");
        assert_eq!(registry_line(4242, "cmd.exe"), "4242\tcmd.exe");
    }

    #[test]
    fn registry_line_round_trips_through_the_parser() {
        let (pid, recorded) =
            parse_registry_line(&registry_line(4242, "/usr/local/bin/codex")).expect("parse");
        assert_eq!(pid, 4242);
        assert_eq!(recorded, "codex");
    }

    #[test]
    fn registry_parser_rejects_unsignalable_or_incomplete_records() {
        // `kill(-0, …)` would broadcast to PacketADE's own group; 1 is init.
        assert!(parse_registry_line("0\tclaude").is_none());
        assert!(parse_registry_line("1\tclaude").is_none());
        assert!(parse_registry_line("4242\t").is_none());
        assert!(parse_registry_line("4242").is_none());
        assert!(parse_registry_line("").is_none());
    }

    #[test]
    fn record_spawned_pid_appends_a_parseable_registry_entry() {
        // F5: this registry was written only by a manager nothing constructed,
        // so the startup reaper always read an empty file. Guard the write.
        let path = pty_pids_registry_path();
        let original = fs::read_to_string(&path).unwrap_or_default();

        // A basename no live process can be running, so a stray entry left by a
        // crashed test run can never match a recycled pid on the next launch.
        record_spawned_pid(999_001, "/opt/bin/packetade-test-not-a-real-process");

        let contents = fs::read_to_string(&path).expect("registry written");
        let entry = contents
            .lines()
            .filter_map(parse_registry_line)
            .find(|(pid, _)| *pid == 999_001)
            .expect("recorded pid present in registry");
        assert_eq!(entry.1, "packetade-test-not-a-real-process");

        let _ = fs::write(&path, original);
    }

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
        assert!(
            pending.is_empty(),
            "pending must stay bounded on invalid input"
        );
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
        assert_eq!(transcript.sequence, 2);

        cleanup_transcript_files(&id);
    }
}
