use crate::commands::shared::home_dir;
use crate::core::brand::DATA_DIR_NAME;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationEntry {
    pub id: i64,
    pub text: String,
    pub mode: String,
    pub timestamp: String,
    pub word_count: Option<i64>,
    pub duration_seconds: Option<f64>,
    pub wpm: Option<i64>,
    pub sentiment: Option<f64>,
}

/// Return the path to ~/.packetbench/dictation.db, creating the directory if needed.
fn db_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Could not resolve home directory")?;
    let dir = PathBuf::from(&home).join(DATA_DIR_NAME);
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {DATA_DIR_NAME} dir: {e}"))?;
    }
    Ok(dir.join("dictation.db"))
}

/// Open (or create) the dictation SQLite database and ensure the schema exists.
pub fn get_db() -> Result<Connection, String> {
    let path = db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open dictation DB: {e}"))?;

    // Analytics scans every row while `stop_recording` inserts the transcript it
    // just produced. Without a busy timeout the loser of that race got
    // `database is locked` immediately, and `stop_recording` only warns — so a
    // finished transcription silently vanished from history.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("Failed to configure dictation DB: {e}"))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'transcribe',
            timestamp TEXT NOT NULL,
            word_count INTEGER,
            duration_seconds REAL,
            wpm INTEGER,
            sentiment REAL
        );
        CREATE INDEX IF NOT EXISTS idx_timestamp ON entries(timestamp);
        CREATE INDEX IF NOT EXISTS idx_mode ON entries(mode);",
    )
    .map_err(|e| format!("Failed to create dictation schema: {e}"))?;

    Ok(conn)
}

/// Insert a new dictation entry. Called internally after transcription completes.
pub fn insert_entry(
    text: &str,
    mode: &str,
    duration_seconds: Option<f64>,
    word_count: Option<i64>,
    wpm: Option<i64>,
) -> Result<(), String> {
    let conn = get_db()?;
    let timestamp = chrono_now();

    conn.execute(
        "INSERT INTO entries (text, mode, timestamp, word_count, duration_seconds, wpm)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![text, mode, timestamp, word_count, duration_seconds, wpm],
    )
    .map_err(|e| format!("Failed to insert dictation entry: {e}"))?;

    Ok(())
}

/// Return an ISO-8601 timestamp string for "now" (UTC).
fn chrono_now() -> String {
    // Use std SystemTime — no extra chrono dep needed.
    let now = std::time::SystemTime::now();
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_iso8601_utc(dur.as_secs())
}

/// Format seconds since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ`.
///
/// Note for `analytics.rs`: these are UTC instants, so `hourlyActivity` and the
/// daily streak are bucketed in UTC, not in the user's local day.
fn format_iso8601_utc(secs: u64) -> String {
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since epoch → date via a simple algorithm
    let mut y = 1970i64;
    let mut remaining_days = days as i64;

    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }

    let month_days: [i64; 12] = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining_days < md {
            m = i;
            break;
        }
        remaining_days -= md;
    }

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes,
        seconds
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<DictationEntry> {
    Ok(DictationEntry {
        id: row.get(0)?,
        text: row.get(1)?,
        mode: row.get(2)?,
        timestamp: row.get(3)?,
        word_count: row.get(4)?,
        duration_seconds: row.get(5)?,
        wpm: row.get(6)?,
        sentiment: row.get(7)?,
    })
}

/// Upper bound on a single history page. An unbounded `limit` from the frontend
/// would otherwise pull every transcript ever recorded into memory and across
/// the IPC bridge in one call.
const MAX_HISTORY_PAGE: u32 = 500;

#[tauri::command]
pub fn get_dictation_history(limit: u32, offset: u32) -> Result<String, String> {
    let limit = limit.clamp(1, MAX_HISTORY_PAGE);
    let conn = get_db()?;
    // `id DESC` breaks ties: timestamps only have second resolution, so two
    // entries recorded in the same second could otherwise appear on two
    // consecutive pages or on neither.
    let mut stmt = conn
        .prepare(
            "SELECT id, text, mode, timestamp, word_count, duration_seconds, wpm, sentiment
             FROM entries ORDER BY timestamp DESC, id DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| format!("SQL prepare error: {e}"))?;

    let entries: Vec<DictationEntry> = stmt
        .query_map(params![limit, offset], |row| row_to_entry(row))
        .map_err(|e| format!("SQL query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&entries).map_err(|e| format!("JSON serialization error: {e}"))
}

/// Escape the characters SQLite's LIKE treats as wildcards.
///
/// Failure mode: searching for `%` or `_` matched every entry, and a search for
/// a literal `100%` matched far more than it should.
fn escape_like_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len());
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

#[tauri::command]
pub fn search_dictation_history(query: String) -> Result<String, String> {
    let conn = get_db()?;
    let pattern = format!("%{}%", escape_like_pattern(&query));

    let mut stmt = conn
        .prepare(
            "SELECT id, text, mode, timestamp, word_count, duration_seconds, wpm, sentiment
             FROM entries WHERE text LIKE ?1 ESCAPE '\\'
             ORDER BY timestamp DESC, id DESC LIMIT 200",
        )
        .map_err(|e| format!("SQL prepare error: {e}"))?;

    let entries: Vec<DictationEntry> = stmt
        .query_map(params![pattern], |row| row_to_entry(row))
        .map_err(|e| format!("SQL query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&entries).map_err(|e| format!("JSON serialization error: {e}"))
}

#[tauri::command]
pub fn insert_dictation_entry(
    text: String,
    mode: String,
    duration_seconds: Option<f64>,
    word_count: Option<i64>,
    wpm: Option<i64>,
) -> Result<(), String> {
    insert_entry(&text, &mode, duration_seconds, word_count, wpm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_matches_known_epoch_instants() {
        assert_eq!(format_iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_iso8601_utc(1), "1970-01-01T00:00:01Z");
        // 2000-02-29: the leap-year branch of a century year.
        assert_eq!(format_iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        // 2100 is not a leap year; 2100-03-01 must not come out as 02-29.
        assert_eq!(format_iso8601_utc(4_107_542_400), "2100-03-01T00:00:00Z");
        assert_eq!(format_iso8601_utc(1_756_252_800), "2025-08-27T00:00:00Z");
        assert_eq!(format_iso8601_utc(1_735_689_599), "2024-12-31T23:59:59Z");
    }

    #[test]
    fn iso8601_output_is_sortable_and_parseable_by_analytics() {
        // analytics.rs slices [..10] for the day and [11..13] for the hour.
        let stamp = format_iso8601_utc(1_735_689_599);
        assert_eq!(stamp.len(), 20);
        assert_eq!(&stamp[..10], "2024-12-31");
        assert_eq!(stamp[11..13].parse::<u32>().unwrap(), 23);
    }

    #[test]
    fn like_wildcards_in_a_search_query_are_escaped() {
        assert_eq!(escape_like_pattern("100%"), r"100\%");
        assert_eq!(escape_like_pattern("a_b"), r"a\_b");
        assert_eq!(escape_like_pattern(r"c:\tmp"), r"c:\\tmp");
        assert_eq!(escape_like_pattern("plain text"), "plain text");
    }

    #[test]
    fn history_page_size_is_bounded() {
        assert_eq!(u32::MAX.clamp(1, MAX_HISTORY_PAGE), MAX_HISTORY_PAGE);
        assert_eq!(0u32.clamp(1, MAX_HISTORY_PAGE), 1);
    }
}
