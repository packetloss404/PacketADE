//! Mission journal — append-only markdown log at
//! `~/.packetade/missions/<shortId>_<mission_id>.md`.
//!
//! Every notable event in the lifecycle of a mission (user/planner chat
//! turns, tool calls, wake triggers, approvals, system notes) is appended
//! here as a self-describing markdown block. The Journal tab in the UI
//! renders this file verbatim; the structured HTML comment headers let a
//! future reader parse the file back into [`JournalEntry`] records.
//!
//! Sibling slices wire this up:
//!   * E7-HOOKS  — calls `append_journal` from the planner runtime / wake
//!     consumer / approval flow.
//!   * E7-UI / E7-INTEGRATE — exposes `read_journal` via a Tauri command
//!     for the Journal tab.
//!
//! This module only owns the types + storage helpers.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

// === Types ===

/// What kind of thing this journal entry records. Each variant maps to
/// a distinct markdown rendering style in the Journal tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalKind {
    /// User typed a message in spec mode or post-launch chat.
    UserMessage,
    /// Planner emitted a chat-style response (aggregated from streaming
    /// chunks into a single final turn).
    PlannerMessage,
    /// Planner called a tool (`create_milestone`, `create_task`, etc.).
    ToolCall,
    /// A wake trigger fired from the orchestrator or system
    /// (`task_completed`, `task_failed`, `approval_gate_reached`, etc.).
    WakeTrigger,
    /// Planner asked the user for approval via `request_user_approval`.
    ApprovalRequest,
    /// System note (status transitions, kill-switch, quota-paused, etc.).
    SystemNote,
}

/// A single append-only entry in the mission journal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    /// uuid for cross-reference (event id, tool call id, etc.).
    pub id: String,
    pub mission_id: String,
    /// Unix millis.
    pub timestamp: u64,
    pub kind: JournalKind,
    /// Markdown body. Kind-aware rendering happens at read time.
    pub content_md: String,
    /// Optional structured payload (the originating tool args, the wake
    /// trigger kind, the approval id, etc.) for future analyses. Never
    /// rendered directly in the markdown body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Bounded read result for UI consumers that only need the latest journal
/// context. `truncated=true` means `markdown` is a tail slice, not the full
/// archive on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRead {
    pub markdown: String,
    pub total_bytes: u64,
    pub returned_bytes: u64,
    pub truncated: bool,
}

// === Storage location ===

/// Directory containing per-mission journal files. Created lazily on the
/// first append (see [`append_journal`]).
pub fn journal_dir() -> PathBuf {
    crate::core::storage::data_dir().join("missions")
}

/// Compute the file path for a mission's journal. The filename pairs the
/// frontend-style shortId (last 4 chars of the mission id, uppercased)
/// with the full mission id for uniqueness:
/// `F-XXXX_<mission_id>.md` — readable in finder + unambiguous.
///
/// Mirrors the JS derivation in `MissionsView.tsx::shortId`:
/// ```js
/// id.replace(/^[a-z]+-/i, "").slice(-4).toUpperCase()
/// ```
///
/// **Path-traversal guard.** Mission ids in production are UUID-ish (hex +
/// dashes) but this function takes `&str` and is callable from anywhere a
/// `mission_id` flows through, including the Tauri command boundary. If the
/// input contains path-escape characters (`/`, `\`, `..`, `\0`) or is
/// empty, we return a sentinel path inside `journal_dir()` rather than
/// allowing the filename component to escape the directory. Mirrors the
/// guard in `commands::mission_planner::read_conversation_tail`.
pub fn journal_path(mission_id: &str) -> PathBuf {
    if mission_id.is_empty()
        || mission_id.contains('/')
        || mission_id.contains('\\')
        || mission_id.contains("..")
        || mission_id.contains('\0')
    {
        // Sentinel path inside `journal_dir()` — no real mission will have
        // this filename, and `read_journal` returns `Ok("")` when the file
        // doesn't exist, so callers degrade gracefully.
        return journal_dir().join("__invalid_mission_id__.md");
    }
    let stripped = strip_leading_kind_prefix(mission_id);
    let tail: String = stripped
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let tail = tail.to_uppercase();
    let filename = format!("F-{}_{}.md", tail, mission_id);
    journal_dir().join(filename)
}

/// Strip a single leading `[a-z]+-` prefix (e.g. `flight-`, `mission-`)
/// to match the frontend's `shortId` regex.
fn strip_leading_kind_prefix(id: &str) -> &str {
    if let Some(dash) = id.find('-') {
        let prefix = &id[..dash];
        if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_alphabetic()) {
            return &id[dash + 1..];
        }
    }
    id
}

// === Append helper ===

/// Append a journal entry to the mission's markdown file. Opens the file
/// in append mode (creating it if it doesn't exist) and writes a single
/// markdown block. Concurrent appends from multiple async tasks are safe
/// at the OS level on Windows / macOS / Linux because each `write_all`
/// is a single small write to a file opened with `append(true)`.
///
/// File format: each entry is a markdown block prefixed by an HTML
/// comment encoding the structured fields, so a reader can parse the
/// file back into [`JournalEntry`] records if needed:
///
/// ```markdown
/// <!-- entry id:abc kind:tool_call ts:1700000000000 -->
/// ## 1700000000000 — tool call
///
/// body text
/// ```
pub async fn append_journal(entry: &JournalEntry) -> Result<(), String> {
    let dir = journal_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create journal dir {:?}: {}", dir, e))?;

    let path = journal_path(&entry.mission_id);
    let block = render_entry_md(entry);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("failed to open journal file {:?}: {}", path, e))?;

    file.write_all(block.as_bytes())
        .map_err(|e| format!("failed to write journal entry: {}", e))?;

    Ok(())
}

fn render_entry_md(entry: &JournalEntry) -> String {
    let kind_str = match entry.kind {
        JournalKind::UserMessage => "user_message",
        JournalKind::PlannerMessage => "planner_message",
        JournalKind::ToolCall => "tool_call",
        JournalKind::WakeTrigger => "wake_trigger",
        JournalKind::ApprovalRequest => "approval_request",
        JournalKind::SystemNote => "system_note",
    };
    let ts = format_timestamp(entry.timestamp);
    let header = match entry.kind {
        JournalKind::UserMessage => format!("## {} — **user**", ts),
        JournalKind::PlannerMessage => format!("## {} — **planner**", ts),
        JournalKind::ToolCall => format!("## {} — tool call", ts),
        JournalKind::WakeTrigger => format!("## {} — wake trigger", ts),
        JournalKind::ApprovalRequest => format!("## {} — approval request", ts),
        JournalKind::SystemNote => format!("## {} — system", ts),
    };

    format!(
        "<!-- entry id:{id} kind:{kind} ts:{ts_raw} -->\n{header}\n\n{body}\n\n",
        id = entry.id,
        kind = kind_str,
        ts_raw = entry.timestamp,
        header = header,
        body = entry.content_md.trim_end_matches('\n'),
    )
}

/// V1: emit the raw unix-millis as text. The UI can prettify in JS. We
/// intentionally avoid pulling in `chrono` for a single helper.
fn format_timestamp(unix_millis: u64) -> String {
    unix_millis.to_string()
}

// === Read helper ===

/// Read the journal file for a mission, returning the raw markdown text.
/// Returns `Ok("")` if the file doesn't exist yet (mission has had no
/// recorded activity). Callers that want structured access can parse the
/// HTML comment headers themselves; v1 only returns the markdown source
/// so the Journal tab can render it directly.
pub fn read_journal(mission_id: &str) -> Result<String, String> {
    let path = journal_path(mission_id);
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read journal {:?}: {}", path, e))
}

/// Read at most `max_bytes` from the end of a mission's journal. Large files
/// are snapped to the next journal-entry marker when possible so the UI does
/// not start rendering in the middle of a markdown block.
pub fn read_journal_tail(mission_id: &str, max_bytes: u64) -> Result<JournalRead, String> {
    let path = journal_path(mission_id);
    read_journal_tail_from_path(&path, max_bytes)
}

fn read_journal_tail_from_path(path: &Path, max_bytes: u64) -> Result<JournalRead, String> {
    if !path.exists() {
        return Ok(JournalRead {
            markdown: String::new(),
            total_bytes: 0,
            returned_bytes: 0,
            truncated: false,
        });
    }

    let metadata =
        std::fs::metadata(path).map_err(|e| format!("failed to stat journal {:?}: {}", path, e))?;
    let total_bytes = metadata.len();
    let max_bytes = max_bytes.max(1);

    if total_bytes <= max_bytes {
        let markdown = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read journal {:?}: {}", path, e))?;
        return Ok(JournalRead {
            returned_bytes: markdown.as_bytes().len() as u64,
            markdown,
            total_bytes,
            truncated: false,
        });
    }

    let start = total_bytes.saturating_sub(max_bytes);
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("failed to open journal {:?}: {}", path, e))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("failed to seek journal {:?}: {}", path, e))?;

    let mut bytes = Vec::with_capacity(max_bytes as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("failed to read journal tail {:?}: {}", path, e))?;

    let markdown = snap_tail_to_readable_boundary(String::from_utf8_lossy(&bytes).into_owned());
    Ok(JournalRead {
        returned_bytes: markdown.as_bytes().len() as u64,
        markdown,
        total_bytes,
        truncated: true,
    })
}

fn snap_tail_to_readable_boundary(markdown: String) -> String {
    if let Some(idx) = markdown.find("<!-- entry ") {
        return markdown[idx..].to_string();
    }
    if let Some(idx) = markdown.find('\n') {
        return markdown[idx + 1..].to_string();
    }
    markdown
}

// === Tests ===

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_path_uses_shortid_uppercase() {
        let p = journal_path("flight-abc123def456");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("F-F456_"),
            "expected filename to start with F-F456_, got {}",
            name
        );
        assert!(name.ends_with(".md"));
        assert!(name.contains("flight-abc123def456"));
    }

    #[test]
    fn journal_path_handles_mission_prefix() {
        let p = journal_path("mission-zzzzAB12");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        // last 4 of "zzzzAB12" -> "AB12" -> uppercased "AB12"
        assert!(
            name.starts_with("F-AB12_"),
            "expected F-AB12_ prefix, got {}",
            name
        );
    }

    #[test]
    fn journal_path_handles_short_id_without_prefix() {
        let p = journal_path("abcd");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("F-ABCD_"),
            "expected F-ABCD_ prefix, got {}",
            name
        );
    }

    #[test]
    fn journal_path_rejects_traversal() {
        // Forward-slash traversal — must NOT escape `journal_dir()`.
        let p = journal_path("../../../etc/passwd");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            name, "__invalid_mission_id__.md",
            "expected sentinel filename for ../../../etc/passwd, got {:?}",
            p
        );
        // Confirm the result is still inside journal_dir().
        assert_eq!(p.parent(), Some(journal_dir().as_path()));
    }

    #[test]
    fn journal_path_rejects_backslash() {
        let p = journal_path("..\\Windows\\System32");
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "__invalid_mission_id__.md");
    }

    #[test]
    fn journal_path_rejects_empty_and_nul() {
        let p1 = journal_path("");
        assert_eq!(
            p1.file_name().unwrap().to_string_lossy(),
            "__invalid_mission_id__.md"
        );
        let p2 = journal_path("foo\0bar");
        assert_eq!(
            p2.file_name().unwrap().to_string_lossy(),
            "__invalid_mission_id__.md"
        );
    }

    #[test]
    fn journal_kind_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&JournalKind::ToolCall).unwrap(),
            r#""tool_call""#
        );
        assert_eq!(
            serde_json::to_string(&JournalKind::UserMessage).unwrap(),
            r#""user_message""#
        );
        assert_eq!(
            serde_json::to_string(&JournalKind::WakeTrigger).unwrap(),
            r#""wake_trigger""#
        );
        assert_eq!(
            serde_json::to_string(&JournalKind::ApprovalRequest).unwrap(),
            r#""approval_request""#
        );
        assert_eq!(
            serde_json::to_string(&JournalKind::PlannerMessage).unwrap(),
            r#""planner_message""#
        );
        assert_eq!(
            serde_json::to_string(&JournalKind::SystemNote).unwrap(),
            r#""system_note""#
        );
    }

    #[test]
    fn render_entry_md_includes_id_and_kind_in_comment() {
        let entry = JournalEntry {
            id: "abc".to_string(),
            mission_id: "m1".to_string(),
            timestamp: 1700000000000,
            kind: JournalKind::ToolCall,
            content_md: "body text".to_string(),
            metadata: None,
        };
        let md = render_entry_md(&entry);
        assert!(md.contains("entry id:abc"), "missing entry id: {}", md);
        assert!(md.contains("kind:tool_call"), "missing kind tag: {}", md);
        assert!(md.contains("ts:1700000000000"), "missing ts tag: {}", md);
        assert!(md.contains("body text"), "missing body: {}", md);
        assert!(md.contains("tool call"), "missing header label: {}", md);
    }

    #[test]
    fn render_entry_md_trims_trailing_newlines_in_body() {
        let entry = JournalEntry {
            id: "x".to_string(),
            mission_id: "m1".to_string(),
            timestamp: 1,
            kind: JournalKind::PlannerMessage,
            content_md: "hello\n\n\n".to_string(),
            metadata: None,
        };
        let md = render_entry_md(&entry);
        // body should appear once, followed by exactly the trailing
        // "\n\n" the block adds — no run of >2 newlines after "hello".
        assert!(md.ends_with("hello\n\n"));
    }

    #[test]
    fn journal_entry_roundtrips_through_serde() {
        let entry = JournalEntry {
            id: "id-1".to_string(),
            mission_id: "flight-deadbeef".to_string(),
            timestamp: 42,
            kind: JournalKind::WakeTrigger,
            content_md: "## header\n\nbody".to_string(),
            metadata: Some(serde_json::json!({"trigger": "task_completed"})),
        };
        let s = serde_json::to_string(&entry).unwrap();
        // camelCase field names on the wire
        assert!(s.contains(r#""missionId":"flight-deadbeef""#));
        assert!(s.contains(r#""kind":"wake_trigger""#));
        let back: JournalEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(back.id, entry.id);
        assert_eq!(back.mission_id, entry.mission_id);
        assert_eq!(back.timestamp, entry.timestamp);
        assert_eq!(back.kind, entry.kind);
    }

    /// Async file-write test. Writes into the real `~/.packetade/missions`
    /// dir using a uniquely-prefixed mission id so it can't collide with
    /// production data. Gated `#[ignore]` because the suite runs without
    /// a writable HOME on some CI sandboxes; run manually with
    /// `cargo test --lib core::mission_journal::tests::append_journal_creates_file_and_appends -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn append_journal_creates_file_and_appends() {
        let mission_id = format!(
            "test-journal-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let e1 = JournalEntry {
            id: "e1".to_string(),
            mission_id: mission_id.clone(),
            timestamp: 1000,
            kind: JournalKind::UserMessage,
            content_md: "first entry".to_string(),
            metadata: None,
        };
        let e2 = JournalEntry {
            id: "e2".to_string(),
            mission_id: mission_id.clone(),
            timestamp: 2000,
            kind: JournalKind::PlannerMessage,
            content_md: "second entry".to_string(),
            metadata: None,
        };

        append_journal(&e1).await.expect("first append");
        append_journal(&e2).await.expect("second append");

        let text = read_journal(&mission_id).expect("read journal");
        assert!(text.contains("entry id:e1"), "missing e1: {}", text);
        assert!(text.contains("entry id:e2"), "missing e2: {}", text);
        assert!(text.contains("first entry"));
        assert!(text.contains("second entry"));

        // Cleanup: remove the test journal file.
        let path = journal_path(&mission_id);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_journal_returns_empty_for_missing_mission() {
        let mission_id = format!(
            "no-such-mission-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let text = read_journal(&mission_id).expect("read should not error on missing file");
        assert_eq!(text, "");
    }

    #[test]
    fn read_journal_tail_returns_full_file_under_cap() {
        let path = std::env::temp_dir().join(format!(
            "packetade-journal-tail-small-{}.md",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let text = "<!-- entry id:e1 kind:system_note ts:1 -->\n## 1 — system\n\nsmall\n\n";
        std::fs::write(&path, text).expect("write temp journal");

        let read = read_journal_tail_from_path(&path, 4096).expect("read journal tail");
        assert_eq!(read.markdown, text);
        assert_eq!(read.total_bytes, text.as_bytes().len() as u64);
        assert_eq!(read.returned_bytes, text.as_bytes().len() as u64);
        assert!(!read.truncated);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn read_journal_tail_truncates_to_latest_entry_boundary() {
        let path = std::env::temp_dir().join(format!(
            "packetade-journal-tail-large-{}.md",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let latest =
            "<!-- entry id:new kind:planner_message ts:2 -->\n## 2 — **planner**\n\nlatest\n\n";
        let text = format!(
            "{}{}",
            "older context that should not render\n".repeat(80),
            latest
        );
        std::fs::write(&path, &text).expect("write temp journal");

        let read = read_journal_tail_from_path(&path, latest.as_bytes().len() as u64 + 12)
            .expect("read journal tail");
        assert!(read.truncated);
        assert_eq!(read.total_bytes, text.as_bytes().len() as u64);
        assert!(read.returned_bytes <= latest.as_bytes().len() as u64);
        assert!(
            read.markdown.starts_with("<!-- entry id:new"),
            "tail should snap to the latest entry marker, got: {}",
            read.markdown
        );
        assert!(read.markdown.contains("latest"));
        assert!(
            !read.markdown.contains("older context"),
            "bounded tail should not include pre-boundary content"
        );

        let _ = std::fs::remove_file(path);
    }
}
