use crate::commands::shared::home_dir;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
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

/// Return the path to ~/.packetcode/dictation.db, creating the directory if needed.
fn db_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Could not resolve home directory")?;
    let dir = PathBuf::from(&home).join(".packetcode");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .packetcode dir: {e}"))?;
    }
    Ok(dir.join("dictation.db"))
}

/// Open (or create) the dictation SQLite database and ensure the schema exists.
pub fn get_db() -> Result<Connection, String> {
    let path = db_path()?;
    let conn =
        Connection::open(&path).map_err(|e| format!("Failed to open dictation DB: {e}"))?;

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
    let secs = dur.as_secs();

    // Format as YYYY-MM-DDTHH:MM:SSZ
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

#[tauri::command]
pub fn get_dictation_history(limit: u32, offset: u32) -> Result<String, String> {
    let conn = get_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, text, mode, timestamp, word_count, duration_seconds, wpm, sentiment
             FROM entries ORDER BY timestamp DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| format!("SQL prepare error: {e}"))?;

    let entries: Vec<DictationEntry> = stmt
        .query_map(params![limit, offset], |row| row_to_entry(row))
        .map_err(|e| format!("SQL query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&entries).map_err(|e| format!("JSON serialization error: {e}"))
}

#[tauri::command]
pub fn search_dictation_history(query: String) -> Result<String, String> {
    let conn = get_db()?;
    let pattern = format!("%{query}%");

    let mut stmt = conn
        .prepare(
            "SELECT id, text, mode, timestamp, word_count, duration_seconds, wpm, sentiment
             FROM entries WHERE text LIKE ?1 ORDER BY timestamp DESC LIMIT 200",
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
