use super::sentiment;
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

    init_schema(&conn)?;

    Ok(conn)
}

/// The `entries` schema. Split out from [`get_db`] so tests can stand the same
/// table up on an in-memory connection instead of writing to the user's real
/// `~/.packetbench/dictation.db`.
const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS entries (
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
        CREATE INDEX IF NOT EXISTS idx_mode ON entries(mode);";

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("Failed to create dictation schema: {e}"))
}

/// Insert a new dictation entry. Called internally after transcription completes.
///
/// `sentiment` is derived here rather than passed in: it is a pure function of
/// `text`, and every caller (`audio.rs` after a transcription, the
/// `insert_dictation_entry` command) wants the same score. Deriving it at the
/// single write point is what stops the column going NULL again.
pub fn insert_entry(
    text: &str,
    mode: &str,
    duration_seconds: Option<f64>,
    word_count: Option<i64>,
    wpm: Option<i64>,
) -> Result<(), String> {
    let conn = get_db()?;
    insert_entry_with_conn(
        &conn,
        text,
        mode,
        &chrono_now(),
        duration_seconds,
        word_count,
        wpm,
    )
}

/// The actual write. Takes the connection and timestamp so tests can drive it
/// deterministically against an in-memory database.
fn insert_entry_with_conn(
    conn: &Connection,
    text: &str,
    mode: &str,
    timestamp: &str,
    duration_seconds: Option<f64>,
    word_count: Option<i64>,
    wpm: Option<i64>,
) -> Result<(), String> {
    // VADER compound score in [-1.0, 1.0]; `analytics.rs` averages this and
    // `DictationView.tsx` renders it as the "Avg Sentiment" card. Before this
    // was wired up the column was NULL on every row ever written.
    let sentiment = sentiment::score(text);

    conn.execute(
        "INSERT INTO entries (text, mode, timestamp, word_count, duration_seconds, wpm, sentiment)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            text,
            mode,
            timestamp,
            word_count,
            duration_seconds,
            wpm,
            sentiment
        ],
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

/// Delete one transcript by row id.
///
/// Until this existed the only way to remove a transcript was to delete the
/// `dictation.db` file by hand, which takes the whole corpus with it.
/// Dictation captures whatever was said into the microphone, so a single
/// misfire can hold something the user does not want kept, and "all or
/// nothing" is not an acceptable answer to that.
///
/// A missing id is an error rather than a silent success: the UI removes the
/// row optimistically, and a no-op DELETE would leave it looking deleted while
/// the transcript is still on disk.
#[tauri::command]
pub fn delete_dictation_entry(id: i64) -> Result<(), String> {
    let conn = get_db()?;
    delete_entry_with_conn(&conn, id)
}

fn delete_entry_with_conn(conn: &Connection, id: i64) -> Result<(), String> {
    let removed = conn
        .execute("DELETE FROM entries WHERE id = ?1", params![id])
        .map_err(|e| format!("SQL delete error: {e}"))?;
    if removed == 0 {
        return Err(format!("No dictation entry with id {id}"));
    }
    Ok(())
}

/// Delete every transcript, returning how many rows went.
///
/// The count is what the caller reports back to the user; a bare `Ok(())`
/// after a destructive sweep gives them no way to tell "cleared 412 entries"
/// from "the button did nothing".
///
/// `VACUUM` follows the delete on purpose: SQLite would otherwise keep the
/// freed pages in the file, so a user who clears their history to get the
/// transcripts off disk would find the database exactly as large as before.
/// A failed vacuum is logged, not surfaced — the rows are already gone and
/// the user's request has been honoured.
#[tauri::command]
pub fn clear_dictation_history() -> Result<u32, String> {
    let conn = get_db()?;
    let removed = clear_entries_with_conn(&conn)?;
    if let Err(err) = conn.execute_batch("VACUUM") {
        tracing::warn!("Cleared dictation history but could not vacuum the database: {err}");
    }
    Ok(removed)
}

fn clear_entries_with_conn(conn: &Connection) -> Result<u32, String> {
    let removed = conn
        .execute("DELETE FROM entries", [])
        .map_err(|e| format!("SQL delete error: {e}"))?;
    Ok(u32::try_from(removed).unwrap_or(u32::MAX))
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

    fn count_entries(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .expect("count entries")
    }

    fn insert_text(conn: &Connection, text: &str) {
        insert_entry_with_conn(
            conn,
            text,
            "transcribe",
            "2026-08-29T10:00:00Z",
            Some(1.0),
            Some(1),
            Some(60),
        )
        .expect("insert");
    }

    #[test]
    fn deleting_one_entry_leaves_the_rest_alone() {
        let conn = memory_db();
        insert_text(&conn, "keep this one");
        insert_text(&conn, "remove this one");
        let doomed: i64 = conn
            .query_row(
                "SELECT id FROM entries WHERE text = 'remove this one'",
                [],
                |row| row.get(0),
            )
            .expect("select id");

        delete_entry_with_conn(&conn, doomed).expect("delete");

        assert_eq!(count_entries(&conn), 1);
        let survivor: String = conn
            .query_row("SELECT text FROM entries", [], |row| row.get(0))
            .expect("select survivor");
        assert_eq!(survivor, "keep this one");
    }

    /// The UI drops the row before the round-trip returns, so a DELETE that
    /// matched nothing has to come back as an error — otherwise a transcript
    /// stays on disk while the user watches it disappear.
    #[test]
    fn deleting_a_missing_entry_is_an_error_not_a_silent_no_op() {
        let conn = memory_db();
        insert_text(&conn, "the only entry");

        let result = delete_entry_with_conn(&conn, 9_999);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("9999"));
        assert_eq!(count_entries(&conn), 1);
    }

    #[test]
    fn clearing_removes_every_entry_and_reports_the_count() {
        let conn = memory_db();
        for text in ["one", "two", "three"] {
            insert_text(&conn, text);
        }

        assert_eq!(clear_entries_with_conn(&conn).expect("clear"), 3);
        assert_eq!(count_entries(&conn), 0);
        // Clearing an already-empty history is not an error; it just moves no
        // rows. The confirm dialog is reachable from an empty list too.
        assert_eq!(clear_entries_with_conn(&conn).expect("clear again"), 0);
    }

    #[test]
    fn like_wildcards_in_a_search_query_are_escaped() {
        assert_eq!(escape_like_pattern("100%"), r"100\%");
        assert_eq!(escape_like_pattern("a_b"), r"a\_b");
        assert_eq!(escape_like_pattern(r"c:\tmp"), r"c:\\tmp");
        assert_eq!(escape_like_pattern("plain text"), "plain text");
    }

    /// An in-memory stand-in for the real DB, built from the same `SCHEMA_SQL`
    /// `get_db` uses.
    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        init_schema(&conn).expect("schema");
        conn
    }

    fn stored_sentiment(conn: &Connection) -> Option<f64> {
        conn.query_row("SELECT sentiment FROM entries LIMIT 1", [], |row| {
            row.get(0)
        })
        .expect("select sentiment")
    }

    /// The regression this port exists for: the INSERT used to omit `sentiment`
    /// entirely, so every row was NULL and `average_sentiment` was computed
    /// over nothing.
    #[test]
    fn insert_entry_persists_a_non_null_sentiment() {
        let conn = memory_db();
        let text = "This is absolutely wonderful and I love it!";
        insert_entry_with_conn(
            &conn,
            text,
            "transcribe",
            "2026-08-28T10:00:00Z",
            None,
            None,
            None,
        )
        .expect("insert");

        let stored = stored_sentiment(&conn).expect("sentiment must not be NULL");
        assert!(
            (stored - sentiment::score(text)).abs() < 1e-9,
            "stored {stored} should equal the scorer's output"
        );
        assert!(stored > 0.3, "positive text should store a positive score");
        assert!((-1.0..=1.0).contains(&stored));
    }

    /// Negative text must round-trip with its sign intact — a column typed REAL
    /// but bound from the wrong slot would silently store a word count here.
    #[test]
    fn insert_entry_persists_negative_sentiment() {
        let conn = memory_db();
        insert_entry_with_conn(
            &conn,
            "This is horrible and I hate it.",
            "transcribe",
            "2026-08-28T10:00:00Z",
            Some(4.0),
            Some(7),
            Some(105),
        )
        .expect("insert");
        let stored = stored_sentiment(&conn).expect("sentiment must not be NULL");
        assert!(stored < -0.3, "expected clearly negative, got {stored}");
    }

    /// Neutral input still writes 0.0, not NULL — an unscored row and a
    /// genuinely neutral row must be distinguishable in the aggregate.
    #[test]
    fn neutral_text_writes_zero_rather_than_null() {
        let conn = memory_db();
        insert_entry_with_conn(
            &conn,
            "open the file and run the build",
            "transcribe",
            "2026-08-28T10:00:00Z",
            None,
            None,
            None,
        )
        .expect("insert");
        assert_eq!(stored_sentiment(&conn), Some(0.0));
    }

    /// All eight columns must survive the round trip in the right slots — the
    /// INSERT column list and the `params!` order are easy to desynchronise now
    /// that there are seven bindings.
    #[test]
    fn insert_entry_round_trips_every_column() {
        let conn = memory_db();
        insert_entry_with_conn(
            &conn,
            "hello there",
            "cleanup",
            "2026-08-28T10:00:00Z",
            Some(12.5),
            Some(2),
            Some(96),
        )
        .expect("insert");

        let row: (String, String, String, i64, f64, i64, f64) = conn
            .query_row(
                "SELECT text, mode, timestamp, word_count, duration_seconds, wpm, sentiment
                 FROM entries LIMIT 1",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .expect("select row");
        assert_eq!(row.0, "hello there");
        assert_eq!(row.1, "cleanup");
        assert_eq!(row.2, "2026-08-28T10:00:00Z");
        assert_eq!(row.3, 2);
        assert!((row.4 - 12.5).abs() < 1e-9);
        assert_eq!(row.5, 96);
        assert!((-1.0..=1.0).contains(&row.6));
    }

    /// Pre-existing rows keep `sentiment = NULL` (we do not rescore history),
    /// and `analytics.rs` counts only non-NULL rows. Proven here in SQL: the
    /// average over a partially-populated column must be the average of the
    /// *scored* rows, not diluted toward zero by the NULL ones.
    #[test]
    fn null_sentiment_rows_do_not_skew_the_average() {
        let conn = memory_db();
        conn.execute_batch(
            "INSERT INTO entries (text, mode, timestamp, sentiment)
                VALUES ('legacy a', 'transcribe', '2026-01-01T00:00:00Z', NULL);
             INSERT INTO entries (text, mode, timestamp, sentiment)
                VALUES ('legacy b', 'transcribe', '2026-01-02T00:00:00Z', NULL);",
        )
        .expect("seed legacy rows");
        insert_entry_with_conn(
            &conn,
            "wonderful",
            "transcribe",
            "2026-08-28T10:00:00Z",
            None,
            None,
            None,
        )
        .expect("insert");

        // Mirror analytics.rs: `if let Some(s) = row.sentiment` accumulates both
        // the sum and the count, so NULLs contribute to neither.
        let mut stmt = conn.prepare("SELECT sentiment FROM entries").unwrap();
        let values: Vec<Option<f64>> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(values.len(), 3);

        let mut sum = 0.0;
        let mut count = 0u32;
        for v in values {
            if let Some(s) = v {
                sum += s;
                count += 1;
            }
        }
        assert_eq!(count, 1, "only the newly written row is scored");
        let average = sum / count as f64;
        assert!(
            average > 0.3,
            "average must reflect the scored row alone, got {average}"
        );
    }

    #[test]
    fn history_page_size_is_bounded() {
        assert_eq!(u32::MAX.clamp(1, MAX_HISTORY_PAGE), MAX_HISTORY_PAGE);
        assert_eq!(0u32.clamp(1, MAX_HISTORY_PAGE), 1);
    }
}
