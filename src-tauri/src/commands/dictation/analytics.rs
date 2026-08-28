use crate::commands::dictation::history::get_db;
use rusqlite::params;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

const STOPWORDS: &[&str] = &[
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can", "to",
    "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "under", "again", "further", "then", "once",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "each", "few", "more", "most", "other",
    "some", "such", "only", "own", "same", "than", "too", "very", "just", "because", "about", "it",
    "its", "this", "that", "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
    "him", "his", "she", "her", "they", "them", "their", "what", "which", "who", "when", "where",
    "why", "how", "all", "any", "if", "no",
];

#[derive(Debug, Serialize)]
pub struct DictationAnalytics {
    #[serde(rename = "totalEntries")]
    pub total_entries: u32,
    #[serde(rename = "totalWords")]
    pub total_words: u32,
    #[serde(rename = "averageWpm")]
    pub average_wpm: u32,
    #[serde(rename = "fastestWpm")]
    pub fastest_wpm: u32,
    #[serde(rename = "averageSentiment")]
    pub average_sentiment: f64,
    #[serde(rename = "totalDurationMinutes")]
    pub total_duration_minutes: f64,
    #[serde(rename = "longestEntryWords")]
    pub longest_entry_words: u32,
    #[serde(rename = "hourlyActivity")]
    pub hourly_activity: [u32; 24],
    #[serde(rename = "topWords")]
    pub top_words: Vec<(String, u32)>,
    #[serde(rename = "modeBreakdown")]
    pub mode_breakdown: HashMap<String, u32>,
    #[serde(rename = "vocabularyDiversity")]
    pub vocabulary_diversity: f64,
    #[serde(rename = "dailyStreak")]
    pub daily_streak: u32,
    #[serde(rename = "timeSavedMinutes")]
    pub time_saved_minutes: f64,
}

#[tauri::command]
pub fn get_dictation_analytics() -> Result<String, String> {
    let conn = get_db()?;

    // Fetch all entries
    let mut stmt = conn
        .prepare("SELECT text, mode, timestamp, word_count, duration_seconds, wpm, sentiment FROM entries ORDER BY timestamp ASC")
        .map_err(|e| format!("SQL error: {e}"))?;

    struct Row {
        text: String,
        mode: String,
        timestamp: String,
        word_count: Option<i64>,
        duration_seconds: Option<f64>,
        wpm: Option<i64>,
        sentiment: Option<f64>,
    }

    let rows: Vec<Row> = stmt
        .query_map(params![], |row| {
            Ok(Row {
                text: row.get(0)?,
                mode: row.get(1)?,
                timestamp: row.get(2)?,
                word_count: row.get(3)?,
                duration_seconds: row.get(4)?,
                wpm: row.get(5)?,
                sentiment: row.get(6)?,
            })
        })
        .map_err(|e| format!("SQL query error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let total_entries = rows.len() as u32;

    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();

    let mut total_words: u64 = 0;
    let mut total_wpm_sum: u64 = 0;
    let mut wpm_count: u32 = 0;
    let mut fastest_wpm: u32 = 0;
    let mut longest_entry_words: u32 = 0;
    let mut total_duration: f64 = 0.0;
    let mut sentiment_sum: f64 = 0.0;
    let mut sentiment_count: u32 = 0;
    let mut hourly_activity = [0u32; 24];
    let mut mode_breakdown: HashMap<String, u32> = HashMap::new();
    let mut word_freq: HashMap<String, u32> = HashMap::new();
    let mut unique_words: HashSet<String> = HashSet::new();
    let mut days_with_entries: HashSet<String> = HashSet::new();

    for row in &rows {
        // Word count.
        //
        // `insert_dictation_entry` is a Tauri command that accepts arbitrary
        // i64s, and older rows may hold anything. `x as u32` on a negative i64
        // wraps to ~4 billion, which used to blow out `longestEntryWords`,
        // `fastestWpm` and the `totalWords` sum. Clamp at the boundary instead.
        let wc = row
            .word_count
            .unwrap_or_else(|| row.text.split_whitespace().count() as i64)
            .max(0) as u64;
        total_words += wc;
        longest_entry_words = longest_entry_words.max(u32::try_from(wc).unwrap_or(u32::MAX));

        // WPM
        if let Some(w) = row.wpm {
            let w = w.max(0) as u64;
            total_wpm_sum += w;
            wpm_count += 1;
            fastest_wpm = fastest_wpm.max(u32::try_from(w).unwrap_or(u32::MAX));
        }

        // Duration
        if let Some(d) = row.duration_seconds {
            total_duration += d;
        }

        // Sentiment
        if let Some(s) = row.sentiment {
            sentiment_sum += s;
            sentiment_count += 1;
        }

        // Mode breakdown
        *mode_breakdown.entry(row.mode.clone()).or_insert(0) += 1;

        // Hourly activity — parse hour from timestamp (format: ...THH:MM:SS...)
        //
        // Both of these used to index with `[..]`, which PANICS on a short or
        // non-UTF-8-boundary timestamp. A single malformed row (an older schema,
        // a hand-edited or partially corrupted dictation.db) took the whole
        // analytics command down instead of being skipped. `get` returns None.
        //
        // Bucketing is UTC, matching `history::format_iso8601_utc`; see the
        // known-issue note there.
        if let Some(t_pos) = row.timestamp.find('T') {
            if let Some(hour) = row
                .timestamp
                .get(t_pos + 1..t_pos + 3)
                .and_then(|value| value.parse::<usize>().ok())
            {
                if hour < 24 {
                    hourly_activity[hour] += 1;
                }
            }
        }

        // Day for streak calculation (YYYY-MM-DD)
        if let Some(day) = row.timestamp.get(..10) {
            days_with_entries.insert(day.to_string());
        }

        // Word frequency + unique words
        for word in row.text.split_whitespace() {
            let clean: String = word
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            if clean.len() > 2 && !stopwords.contains(clean.as_str()) {
                *word_freq.entry(clean.clone()).or_insert(0) += 1;
            }
            if !clean.is_empty() {
                unique_words.insert(clean);
            }
        }
    }

    // Top 20 words
    let mut word_vec: Vec<(String, u32)> = word_freq.into_iter().collect();
    word_vec.sort_by(|a, b| b.1.cmp(&a.1));
    word_vec.truncate(20);

    // Vocabulary diversity
    let vocabulary_diversity = if total_words > 0 {
        unique_words.len() as f64 / total_words as f64
    } else {
        0.0
    };

    // Average WPM
    let average_wpm = if wpm_count > 0 {
        (total_wpm_sum / wpm_count as u64) as u32
    } else {
        0
    };

    // Daily streak — count consecutive days ending at the most recent entry day
    let daily_streak = compute_daily_streak(&days_with_entries);

    // Time saved: (total_words / 40) - (total_duration / 60)
    // typing at 40 wpm vs dictation duration
    let time_saved_minutes = (total_words as f64 / 40.0) - (total_duration / 60.0);

    let average_sentiment = if sentiment_count > 0 {
        sentiment_sum / sentiment_count as f64
    } else {
        0.0
    };

    let total_duration_minutes = total_duration / 60.0;

    let analytics = DictationAnalytics {
        total_entries,
        total_words: u32::try_from(total_words).unwrap_or(u32::MAX),
        average_wpm,
        fastest_wpm,
        average_sentiment,
        total_duration_minutes,
        longest_entry_words,
        hourly_activity,
        top_words: word_vec,
        mode_breakdown,
        vocabulary_diversity,
        daily_streak,
        time_saved_minutes: if time_saved_minutes > 0.0 {
            time_saved_minutes
        } else {
            0.0
        },
    };

    serde_json::to_string(&analytics).map_err(|e| format!("JSON serialization error: {e}"))
}

/// Compute the longest consecutive-day streak ending at the most recent day.
fn compute_daily_streak(days: &HashSet<String>) -> u32 {
    if days.is_empty() {
        return 0;
    }

    let mut sorted: Vec<&String> = days.iter().collect();
    sorted.sort();

    // Walk backwards from the last day
    let mut streak = 1u32;
    for i in (0..sorted.len() - 1).rev() {
        let curr = &sorted[i];
        let next = &sorted[i + 1];
        if are_consecutive_days(curr, next) {
            streak += 1;
        } else {
            break;
        }
    }

    streak
}

/// Check if two YYYY-MM-DD date strings represent consecutive calendar days.
fn are_consecutive_days(a: &str, b: &str) -> bool {
    // Parse simple date strings
    fn parse_date(s: &str) -> Option<(i32, u32, u32)> {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 3 {
            return None;
        }
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    }

    fn days_in_month(y: i32, m: u32) -> u32 {
        match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 => {
                if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                    29
                } else {
                    28
                }
            }
            _ => 30,
        }
    }

    fn next_day(y: i32, m: u32, d: u32) -> (i32, u32, u32) {
        let max_d = days_in_month(y, m);
        if d < max_d {
            (y, m, d + 1)
        } else if m < 12 {
            (y, m + 1, 1)
        } else {
            (y + 1, 1, 1)
        }
    }

    if let (Some((ay, am, ad)), Some(b_date)) = (parse_date(a), parse_date(b)) {
        next_day(ay, am, ad) == b_date
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the parsing `get_dictation_analytics` does per row so the
    /// panic-safety of the slicing can be exercised without a database.
    fn parse_hour_and_day(timestamp: &str) -> (Option<usize>, Option<&str>) {
        let hour = timestamp.find('T').and_then(|t_pos| {
            timestamp
                .get(t_pos + 1..t_pos + 3)
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|hour| *hour < 24)
        });
        (hour, timestamp.get(..10))
    }

    #[test]
    fn well_formed_timestamps_parse() {
        let (hour, day) = parse_hour_and_day("2026-08-27T14:05:09Z");
        assert_eq!(hour, Some(14));
        assert_eq!(day, Some("2026-08-27"));
    }

    #[test]
    fn malformed_timestamps_are_skipped_instead_of_panicking() {
        // Each of these panicked with the previous `[a..b]` slicing.
        for stamp in [
            "2026-08-27T",
            "2026-08-27T1",
            "T",
            "",
            "短",
            "2026-08-27T9x:00Z",
        ] {
            let (hour, _day) = parse_hour_and_day(stamp);
            assert!(hour.is_none(), "unexpectedly parsed an hour from {stamp:?}");
        }
        assert_eq!(parse_hour_and_day("短い").1, None);
        assert_eq!(parse_hour_and_day("2026-08-27T25:00:00Z").0, None);
    }

    #[test]
    fn consecutive_day_detection_handles_month_and_year_rollover() {
        assert!(are_consecutive_days("2026-01-31", "2026-02-01"));
        assert!(are_consecutive_days("2026-12-31", "2027-01-01"));
        assert!(are_consecutive_days("2024-02-28", "2024-02-29"));
        assert!(!are_consecutive_days("2025-02-28", "2025-02-29"));
        assert!(!are_consecutive_days("2026-01-01", "2026-01-03"));
        assert!(!are_consecutive_days("garbage", "2026-01-02"));
    }

    #[test]
    fn streak_counts_only_the_run_of_consecutive_days() {
        let days: HashSet<String> = ["2026-08-20", "2026-08-25", "2026-08-26", "2026-08-27"]
            .iter()
            .map(|d| d.to_string())
            .collect();
        assert_eq!(compute_daily_streak(&days), 3);
        assert_eq!(compute_daily_streak(&HashSet::new()), 0);
    }

    #[test]
    fn negative_counters_cannot_wrap_into_huge_totals() {
        // The wrapping form this replaced: `(-1i64) as u32 == 4_294_967_295`.
        let wc = (-1i64).max(0) as u64;
        assert_eq!(wc, 0);
        assert_eq!(u32::try_from(u64::MAX).unwrap_or(u32::MAX), u32::MAX);
    }
}
