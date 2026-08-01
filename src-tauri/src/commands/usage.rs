use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::commands::shared::home_dir;
use crate::core::brand::DATA_DIR_NAME;

/// One append-only row of `~/.packetade/usage.jsonl`.
///
/// Token counts are the vendor's **raw** numbers — for OpenAI-family models
/// `input_tokens` is a superset that already contains `cache_read`. Callers
/// normalise at the cost call site via `pricing::billable_input_tokens`; the
/// stored row keeps the vendor's own figures.
///
/// Rows rewritten by the one-time historical reprice (`core::reprice`) carry
/// two extra keys not modelled here: `repriced_at` (ISO timestamp of the pass)
/// and `cost_usd_before` (the figure computed with the pre-CE2 rates). Serde
/// ignores unknown fields, so those rows still deserialize into this struct —
/// but a rewrite of this record shape must preserve them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageEntry {
    pub ts: String,
    pub source: String,
    pub model: String,
    pub agent_id: Option<String>,
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
}

/// Returns `<home>/.packetade/usage.jsonl` if the home directory is resolvable.
pub fn usage_log_path() -> Option<PathBuf> {
    let home = home_dir()?;
    let mut p = PathBuf::from(home);
    p.push(DATA_DIR_NAME);
    p.push("usage.jsonl");
    Some(p)
}

/// Appends a single `UsageEntry` as a JSON line to the usage log, creating parent
/// directories as needed.
pub fn append_usage_entry(entry: &UsageEntry) -> Result<(), String> {
    let path = usage_log_path().ok_or_else(|| "Could not resolve home directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create usage log directory: {}", e))?;
    }

    let line = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize usage entry: {}", e))?;

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open usage log {}: {}", path.display(), e))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write usage entry: {}", e))?;
    file.write_all(b"\n")
        .map_err(|e| format!("Failed to write usage entry newline: {}", e))?;

    Ok(())
}

/// Returns an ISO 8601 UTC timestamp (e.g. `2026-04-16T12:34:56Z`).
///
/// Hand-rolled because `chrono` is not a dependency. Uses the proleptic
/// Gregorian calendar and handles leap years; output is parseable by any
/// ISO 8601 / RFC 3339 consumer.
pub fn current_timestamp_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs() as i64;

    let days = total_secs.div_euclid(86_400);
    let secs_in_day = total_secs.rem_euclid(86_400);
    let hour = (secs_in_day / 3600) as u32;
    let minute = ((secs_in_day % 3600) / 60) as u32;
    let second = (secs_in_day % 60) as u32;

    let (year, month, day) = days_to_ymd(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// Convert a millisecond Unix timestamp into a `YYYY-MM-DD` UTC date string —
/// the shape `pricing::pricing_for_at` / `calculate_cost_at` expect.
///
/// Needed when re-pricing a historical record whose timestamp is ms-epoch
/// rather than an ISO string (persisted conversation messages carry
/// `timestamp: number`). Negative/pre-epoch inputs are impossible for a `u64`,
/// so this never has to handle them.
pub fn iso_date_from_millis(ms: u64) -> String {
    let days = (ms / 1000) as i64 / 86_400;
    let (year, month, day) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", year, month, day)
}

/// Convert a count of days since the Unix epoch (1970-01-01) into a
/// (year, month, day) triple. Correctly handles leap years.
fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    // Algorithm: civil_from_days from Howard Hinnant's date library.
    // Shifts epoch to 0000-03-01 so leap-day is at the end of each cycle.
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_is_iso_shape() {
        let ts = current_timestamp_iso();
        assert_eq!(ts.len(), 20, "expected YYYY-MM-DDTHH:MM:SSZ, got {}", ts);
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
        assert_eq!(&ts[13..14], ":");
        assert_eq!(&ts[16..17], ":");
    }

    #[test]
    fn days_to_ymd_known_dates() {
        // 1970-01-01 is day 0.
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // 2000-01-01 is day 10957.
        assert_eq!(days_to_ymd(10_957), (2000, 1, 1));
        // 2020-02-29 (leap day) is day 18321.
        assert_eq!(days_to_ymd(18_321), (2020, 2, 29));
    }

    #[test]
    fn usage_log_path_ends_correctly() {
        if let Some(p) = usage_log_path() {
            let s = p.to_string_lossy().to_string();
            assert!(s.ends_with("usage.jsonl"));
            assert!(s.contains(DATA_DIR_NAME));
        }
    }
}
