//! Aggregations behind the Dictation → Analytics tab.
//!
//! `get_dictation_analytics` does a single full-table scan of `entries` and
//! returns every derived structure the analytics UI needs. It deliberately does
//! **not** ship raw entries to the frontend: `get_dictation_history` is
//! paginated and clamped to 500 rows, and streaming the whole transcript corpus
//! over IPC on every tab switch would move megabytes of text. Everything the
//! charts need is reduced here.
//!
//! ## Time zone
//!
//! Every calendar bucket in this module — hour, day, day-of-week, "today",
//! "this week" — is **UTC**. `history::format_iso8601_utc` writes UTC instants,
//! the pre-existing `hourlyActivity` / `dailyStreak` fields already bucketed in
//! UTC, and `src-tauri` has no `chrono` dependency (and therefore no tz
//! database) to convert with. The upstream `vibe2text` implementation buckets in
//! the browser's local zone; the two disagree by the local UTC offset near
//! midnight. UTC was chosen for internal consistency and because it is the only
//! option that is correct without a tz database. If local-day bucketing is ever
//! wanted, it has to be done in one place for all of these fields at once.
//!
//! ## Deliberately not ported from `vibe2text/src/analytics.js`
//!
//! * **Mode breakdown / mode donut.** vibe2text has four modes (`transcribe`,
//!   `greppy`, `cleanup`, `plan`) because it runs an LLM post-processing
//!   pipeline. PacketBench hardcodes `"transcribe"` in `audio.rs`, so every row
//!   carries a single mode and a donut of it is a full circle. `mode_breakdown`
//!   stays for the existing UI; do not build anything new on it.
//! * **Topic classification** (`classifyTopic` / `TOPIC_RULES` /
//!   `topicSpeedMood`). Keyword-matched against a taxonomy tuned to one
//!   author's vibe2text usage. Not worth porting blind.
//! * **Session-duration histogram** (`sessionDurations`). Computed upstream but
//!   never rendered — there is no `renderSessionDurations`. The one useful
//!   number from it, the longest session, is exposed as
//!   `longestSessionSeconds`.
//! * **Word cloud** (`wordFrequency`). Upstream ships the *entire* word-frequency
//!   map to render a 40-word cloud. The existing `topWords` (top 20,
//!   stopword-filtered) already backs that surface at a bounded size.

use crate::commands::dictation::history::get_db;
use rusqlite::params;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Phrases made up *entirely* of these are dropped from the bigram/trigram
/// lists. Ported verbatim from the `stopwords` set local to `processData`.
const PHRASE_STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "i", "you",
    "it", "is", "that", "this",
];

/// Filler words counted per-token. Ported verbatim from `FILLER_WORDS`.
/// Reported in this order (including zeros) so the frontend controls sorting.
const FILLER_WORDS: &[&str] = &[
    "um",
    "uh",
    "like",
    "basically",
    "actually",
    "literally",
    "honestly",
    "anyway",
    "so",
    "right",
];

/// Words *not* in this list (and longer than three characters) count as "rare".
///
/// Ported verbatim from `COMMON_WORDS`. Upstream's comment calls it "top ~500";
/// it is actually 301 literals / 291 distinct words. The list is kept as-is
/// rather than "corrected" so rare-word output matches upstream.
const COMMON_WORDS: &[&str] = &[
    "the",
    "be",
    "to",
    "of",
    "and",
    "a",
    "in",
    "that",
    "have",
    "i",
    "it",
    "for",
    "not",
    "on",
    "with",
    "he",
    "as",
    "you",
    "do",
    "at",
    "this",
    "but",
    "his",
    "by",
    "from",
    "they",
    "we",
    "say",
    "her",
    "she",
    "or",
    "an",
    "will",
    "my",
    "one",
    "all",
    "would",
    "there",
    "their",
    "what",
    "so",
    "up",
    "out",
    "if",
    "about",
    "who",
    "get",
    "which",
    "go",
    "me",
    "when",
    "make",
    "can",
    "like",
    "time",
    "no",
    "just",
    "him",
    "know",
    "take",
    "people",
    "into",
    "year",
    "your",
    "good",
    "some",
    "could",
    "them",
    "see",
    "other",
    "than",
    "then",
    "now",
    "look",
    "only",
    "come",
    "its",
    "over",
    "think",
    "also",
    "back",
    "after",
    "use",
    "two",
    "how",
    "our",
    "work",
    "first",
    "well",
    "way",
    "even",
    "new",
    "want",
    "because",
    "any",
    "these",
    "give",
    "day",
    "most",
    "us",
    "is",
    "are",
    "was",
    "were",
    "been",
    "being",
    "has",
    "had",
    "did",
    "does",
    "done",
    "doing",
    "made",
    "got",
    "went",
    "going",
    "came",
    "coming",
    "took",
    "taking",
    "said",
    "saying",
    "put",
    "thing",
    "things",
    "very",
    "much",
    "more",
    "many",
    "still",
    "such",
    "here",
    "those",
    "own",
    "same",
    "right",
    "too",
    "old",
    "before",
    "last",
    "never",
    "where",
    "why",
    "while",
    "should",
    "must",
    "may",
    "might",
    "let",
    "through",
    "down",
    "off",
    "between",
    "under",
    "long",
    "little",
    "great",
    "need",
    "each",
    "every",
    "both",
    "few",
    "shall",
    "part",
    "place",
    "since",
    "around",
    "hand",
    "high",
    "always",
    "sure",
    "something",
    "help",
    "keep",
    "seem",
    "call",
    "point",
    "start",
    "find",
    "show",
    "turn",
    "end",
    "ask",
    "try",
    "tell",
    "feel",
    "become",
    "leave",
    "mean",
    "change",
    "move",
    "play",
    "run",
    "set",
    "big",
    "small",
    "large",
    "another",
    "different",
    "kind",
    "again",
    "home",
    "world",
    "house",
    "life",
    "school",
    "night",
    "city",
    "head",
    "side",
    "water",
    "room",
    "mother",
    "area",
    "money",
    "story",
    "fact",
    "month",
    "lot",
    "study",
    "book",
    "eye",
    "job",
    "word",
    "business",
    "issue",
    "government",
    "company",
    "number",
    "group",
    "problem",
    "state",
    "system",
    "program",
    "question",
    "during",
    "without",
    "children",
    "against",
    "family",
    "case",
    "woman",
    "service",
    "country",
    "however",
    "information",
    "really",
    "actually",
    "probably",
    "maybe",
    "perhaps",
    "okay",
    "yeah",
    "yes",
    "oh",
    "gonna",
    "wanna",
    "gotta",
    "code",
    "function",
    "file",
    "data",
    "type",
    "class",
    "method",
    "value",
    "name",
    "string",
    "array",
    "object",
    "error",
    "test",
    "build",
    "create",
    "add",
    "update",
    "delete",
    "check",
    "fix",
    "copy",
    "save",
    "load",
    "open",
    "close",
    "read",
    "write",
    "send",
    "receive",
    "input",
    "output",
    "return",
];

/// Assumed typing speed used by the "time saved" derivation, matching the
/// pre-existing `timeSavedMinutes` field and upstream's `d.words / 40`.
const TYPING_WPM_BASELINE: f64 = 40.0;

/// Ported from upstream's `DAILY_WORD_GOAL` / `WEEKLY_WORD_GOAL`. Emitted in the
/// payload rather than hardcoded in the UI so they can become a setting later
/// without a second source of truth.
const DAILY_WORD_GOAL: u32 = 500;
const WEEKLY_WORD_GOAL: u32 = 2500;

/// `dailySeries` is capped to this many trailing day-buckets. Everything older
/// is folded into `dailySeriesCarry` so cumulative charts still start from the
/// correct base. Upstream sends every day since first use, which grows without
/// bound; 365 matches the yearly-heatmap window, the widest chart that consumes
/// it.
const DAILY_SERIES_MAX_DAYS: usize = 365;

/// `newWordsThisWeek` can run to thousands of entries for a heavy week. The UI
/// shows a count plus an expandable sample, so only a sample is shipped.
const NEW_WORDS_SAMPLE_LIMIT: usize = 50;

const TOP_BIGRAMS: usize = 10;
const TOP_TRIGRAMS: usize = 5;
const TOP_RARE_WORDS: usize = 20;
/// Minimum occurrences for a phrase or rare word to be reported (upstream
/// `count >= 2`).
const MIN_PHRASE_COUNT: u32 = 2;

/// One day-bucket of the activity series.
///
/// This single series backs seven upstream charts — words/day, time saved,
/// cumulative talking time, WPM over time, the yearly heatmap, vocabulary
/// growth, and sentiment over time. Upstream returned it twice (`dailyArray`
/// plus a `dailyData` map keyed by date) and carried four extra precomputed
/// columns; see `DictationAnalytics::daily_series` for what was collapsed.
///
/// Only days that have at least one entry appear. Dates are UTC `YYYY-MM-DD`,
/// ascending.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DictationDailyPoint {
    pub date: String,
    pub entries: u32,
    pub words: u32,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: f64,
    /// Mean WPM for the day, or `None` when no entry that day recorded a WPM.
    #[serde(rename = "avgWpm")]
    pub avg_wpm: Option<u32>,
    /// Cumulative count of distinct words (longer than two characters) seen at
    /// any point up to and including this day. Monotonically non-decreasing, so
    /// it stays correct even when the series front is truncated.
    #[serde(rename = "vocabSize")]
    pub vocab_size: u32,
    /// Mean sentiment across the *scored* entries of the day, or `None` when no
    /// entry that day has a sentiment score. See
    /// `DictationAnalytics::sentiment_coverage`.
    #[serde(rename = "avgSentiment")]
    pub avg_sentiment: Option<f64>,
}

/// Totals for the day-buckets that fell outside the `dailySeries` window, so
/// cumulative charts can start from the right base instead of at zero.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DictationDailyCarry {
    /// Number of day-buckets folded in. `0` means `dailySeries` is complete.
    pub days: u32,
    pub words: u32,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: f64,
    /// Sum of the per-day `max(0, words/40 - duration/60)` for the folded days.
    /// Not derivable from the totals above, because the per-day clamp at zero
    /// happens before summing.
    #[serde(rename = "timeSavedMinutes")]
    pub time_saved_minutes: f64,
}

/// Totals over a calendar week (UTC, Sunday-start), for the week comparison.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DictationPeriodTotals {
    pub words: u32,
    pub sessions: u32,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: f64,
}

/// Token counts by character length: `1-3`, `4-6`, `7+`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DictationWordLengths {
    pub short: u32,
    pub medium: u32,
    pub long: u32,
}

/// How much of the corpus actually has a sentiment score.
///
/// `sentiment` was never written by `insert_entry` before the VADER scorer
/// landed, so historical rows are `NULL` while new ones are scored. Every
/// sentiment figure in this payload — `averageSentiment` and
/// `DictationDailyPoint::avg_sentiment` — is computed over scored rows only and
/// is `None`/`0.0` where there are none. The UI must use these counts to say
/// "scored 12 of 840 entries" rather than presenting a partial mean as if it
/// covered the whole history.
///
/// Upstream substitutes a naive positive/negative word count for unscored
/// entries and averages that in with real VADER compound scores. That mixes two
/// incompatible scales into one series, so it is not ported.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DictationSentimentCoverage {
    /// Entries with a non-NULL `sentiment` column.
    #[serde(rename = "scoredEntries")]
    pub scored_entries: u32,
    /// Entries scanned, scored or not. Equals `totalEntries`.
    #[serde(rename = "totalEntries")]
    pub total_entries: u32,
    /// Day-buckets with at least one scored entry — i.e. how many points the
    /// sentiment series actually has.
    #[serde(rename = "scoredDays")]
    pub scored_days: u32,
}

#[derive(Debug, Serialize)]
pub struct DictationAnalytics {
    // ---------------------------------------------------------------
    // Pre-existing fields. Consumed by the current UI — do not rename.
    // ---------------------------------------------------------------
    #[serde(rename = "totalEntries")]
    pub total_entries: u32,
    #[serde(rename = "totalWords")]
    pub total_words: u32,
    #[serde(rename = "averageWpm")]
    pub average_wpm: u32,
    /// Also serves as upstream's `maxWpm` personal record — the two are the
    /// same number, so `maxWpm` was not added.
    #[serde(rename = "fastestWpm")]
    pub fastest_wpm: u32,
    /// Mean over scored entries only; `0.0` when nothing is scored. Pair it with
    /// `sentimentCoverage` before showing it.
    #[serde(rename = "averageSentiment")]
    pub average_sentiment: f64,
    #[serde(rename = "totalDurationMinutes")]
    pub total_duration_minutes: f64,
    #[serde(rename = "longestEntryWords")]
    pub longest_entry_words: u32,
    /// Sessions per UTC hour. This is the column sum of `activityMatrix`
    /// (modulo rows whose date is unparseable, which have an hour but no
    /// day-of-week), and that column sum is exactly what upstream's
    /// `renderPeakHours` computes on the fly — so "peak hours" needs no
    /// separate field.
    #[serde(rename = "hourlyActivity")]
    pub hourly_activity: [u32; 24],
    #[serde(rename = "topWords")]
    pub top_words: Vec<(String, u32)>,
    /// Always a single `"transcribe"` bucket in PacketBench. See the module
    /// docs — nothing new should be built on this.
    #[serde(rename = "modeBreakdown")]
    pub mode_breakdown: HashMap<String, u32>,
    #[serde(rename = "vocabularyDiversity")]
    pub vocabulary_diversity: f64,
    /// Consecutive days ending at the most recent day *with an entry*, however
    /// long ago that was. Distinct from `currentStreak`, which resets unless the
    /// run reaches today or yesterday. Kept for the existing UI.
    #[serde(rename = "dailyStreak")]
    pub daily_streak: u32,
    #[serde(rename = "timeSavedMinutes")]
    pub time_saved_minutes: f64,

    // ---------------------------------------------------------------
    // Activity
    // ---------------------------------------------------------------
    /// `[day_of_week][hour]` session counts. Row 0 is Sunday, matching
    /// upstream's `Date#getDay()`. UTC.
    #[serde(rename = "activityMatrix")]
    pub activity_matrix: [[u32; 24]; 7],
    /// Mean WPM per UTC hour, `None` for hours with no WPM-bearing entry.
    #[serde(rename = "wpmByHour")]
    pub wpm_by_hour: [Option<u32>; 24],

    // ---------------------------------------------------------------
    // Daily series
    // ---------------------------------------------------------------
    /// Trailing window of at most [`DAILY_SERIES_MAX_DAYS`] day-buckets,
    /// ascending, days with entries only.
    ///
    /// Collapsed relative to upstream's `dailyArray`/`dailyData`:
    /// * `dailyData` (a date-keyed map of the same rows) is dropped — the
    ///   yearly heatmap can index this array itself in one pass.
    /// * `wpmSum` / `wpmCount` are dropped in favour of the `avgWpm` they only
    ///   existed to produce.
    /// * `timeSavedToday` is dropped — it is
    ///   `max(0, words / 40 - durationSeconds / 60)`.
    /// * `cumulativeTimeSaved` / `cumulativeTalkingTime` are dropped — they are
    ///   running sums of the above, one reduce on the frontend, seeded from
    ///   `dailySeriesCarry`.
    /// * upstream's separate `vocabGrowthArray` and `sentimentArray` are folded
    ///   in as `vocabSize` and `avgSentiment`; they were keyed by the same days.
    #[serde(rename = "dailySeries")]
    pub daily_series: Vec<DictationDailyPoint>,
    #[serde(rename = "dailySeriesCarry")]
    pub daily_series_carry: DictationDailyCarry,

    // ---------------------------------------------------------------
    // Streaks, records, goals
    // ---------------------------------------------------------------
    /// Consecutive days ending today or yesterday; `0` if neither has an entry.
    #[serde(rename = "currentStreak")]
    pub current_streak: u32,
    #[serde(rename = "longestStreak")]
    pub longest_streak: u32,
    #[serde(rename = "maxWordsInDay")]
    pub max_words_in_day: u32,
    #[serde(rename = "longestSessionSeconds")]
    pub longest_session_seconds: f64,
    /// Words dictated today (UTC). Upstream shipped the whole `todayData`
    /// bucket; only `words` is ever read.
    #[serde(rename = "todayWords")]
    pub today_words: u32,
    #[serde(rename = "dailyWordGoal")]
    pub daily_word_goal: u32,
    #[serde(rename = "weeklyWordGoal")]
    pub weekly_word_goal: u32,

    // ---------------------------------------------------------------
    // Week comparison
    // ---------------------------------------------------------------
    /// Current Sunday-start UTC week. Upstream also returned `thisWeekWords` as
    /// a top-level scalar for the weekly goal bar; it is `thisWeek.words`.
    #[serde(rename = "thisWeek")]
    pub this_week: DictationPeriodTotals,
    #[serde(rename = "lastWeek")]
    pub last_week: DictationPeriodTotals,

    // ---------------------------------------------------------------
    // Speech patterns & vocabulary
    // ---------------------------------------------------------------
    /// All ten filler words in a fixed order, zeros included.
    #[serde(rename = "fillerCounts")]
    pub filler_counts: Vec<(String, u32)>,
    /// Two-word phrases seen at least twice, not entirely stopwords. Sorted by
    /// count descending then phrase ascending.
    #[serde(rename = "topBigrams")]
    pub top_bigrams: Vec<(String, u32)>,
    #[serde(rename = "topTrigrams")]
    pub top_trigrams: Vec<(String, u32)>,
    /// Words over three characters that are not in the common-word list, seen at
    /// least twice.
    #[serde(rename = "rareWords")]
    pub rare_words: Vec<(String, u32)>,
    #[serde(rename = "wordLengths")]
    pub word_lengths: DictationWordLengths,
    /// Flesch-Kincaid grade level over the whole corpus, clamped to `1..=18`.
    /// `0.0` when there are no words at all.
    #[serde(rename = "readingLevel")]
    pub reading_level: f64,
    /// Words first used during the current UTC week, in the order they were
    /// first seen, capped at [`NEW_WORDS_SAMPLE_LIMIT`]. Use
    /// `newWordsThisWeekCount` for the headline number.
    #[serde(rename = "newWordsThisWeek")]
    pub new_words_this_week: Vec<String>,
    #[serde(rename = "newWordsThisWeekCount")]
    pub new_words_this_week_count: u32,

    // ---------------------------------------------------------------
    // Sentiment
    // ---------------------------------------------------------------
    #[serde(rename = "sentimentCoverage")]
    pub sentiment_coverage: DictationSentimentCoverage,
}

/// One row of `entries`, as read by the scan.
struct EntryRow {
    text: String,
    mode: String,
    timestamp: String,
    word_count: Option<i64>,
    duration_seconds: Option<f64>,
    wpm: Option<i64>,
    sentiment: Option<f64>,
}

#[tauri::command]
pub fn get_dictation_analytics() -> Result<String, String> {
    let conn = get_db()?;

    // Fetch all entries
    let mut stmt = conn
        .prepare("SELECT text, mode, timestamp, word_count, duration_seconds, wpm, sentiment FROM entries ORDER BY timestamp ASC")
        .map_err(|e| format!("SQL error: {e}"))?;

    let rows: Vec<EntryRow> = stmt
        .query_map(params![], |row| {
            Ok(EntryRow {
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

    let analytics = compute_analytics(&rows, current_day_index());

    serde_json::to_string(&analytics).map_err(|e| format!("JSON serialization error: {e}"))
}

/// Per-day accumulator built during the scan.
#[derive(Default)]
struct DayAccumulator {
    entries: u32,
    words: u64,
    duration: f64,
    wpm_sum: u64,
    wpm_count: u32,
    sentiment_sum: f64,
    sentiment_count: u32,
    /// Words seen for the first time anywhere on this day, for vocabulary growth.
    new_words: u32,
}

/// Reduce every row into the analytics payload.
///
/// Complexity: one pass over the rows, and within a row one pass over its
/// tokens, so `O(W)` in total tokens `W` — every counter above is folded in that
/// same walk, including n-grams, rare words, syllables and first-seen vocabulary
/// tracking. Afterwards it is `O(D log D)` to order the `D` day-buckets and
/// `O(K log K)` to sort each of the word / bigram / trigram / rare-word maps for
/// their top-N slices. Peak memory is dominated by the n-gram maps, which hold
/// up to one entry per distinct adjacent word pair/triple.
///
/// `today` is the UTC day index (days since the epoch) that "today", "this
/// week" and `currentStreak` are measured against; it is a parameter so tests
/// can pin it.
fn compute_analytics(rows: &[EntryRow], today: i64) -> DictationAnalytics {
    let total_entries = rows.len() as u32;

    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();
    let phrase_stopwords: HashSet<&str> = PHRASE_STOPWORDS.iter().copied().collect();
    let common_words: HashSet<&str> = COMMON_WORDS.iter().copied().collect();

    // "This week" is Sunday-start, matching upstream's `now.getDate() - now.getDay()`.
    let start_of_this_week = today - day_of_week(today) as i64;
    let start_of_last_week = start_of_this_week - 7;

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

    let mut activity_matrix = [[0u32; 24]; 7];
    let mut wpm_by_hour_sum = [0u64; 24];
    let mut wpm_by_hour_count = [0u32; 24];
    let mut day_acc: HashMap<i64, DayAccumulator> = HashMap::new();
    let mut longest_session_seconds: f64 = 0.0;

    let mut filler_counts: Vec<u32> = vec![0; FILLER_WORDS.len()];
    let filler_index: HashMap<&str, usize> = FILLER_WORDS
        .iter()
        .enumerate()
        .map(|(i, w)| (*w, i))
        .collect();

    let mut bigrams: HashMap<String, u32> = HashMap::new();
    let mut trigrams: HashMap<String, u32> = HashMap::new();
    let mut rare_word_counts: HashMap<String, u32> = HashMap::new();
    let mut word_lengths = DictationWordLengths::default();

    let mut token_count: u64 = 0;
    let mut total_syllables: u64 = 0;
    let mut total_sentences: u64 = 0;

    let mut new_words_this_week: Vec<String> = Vec::new();
    let mut new_words_this_week_count: u32 = 0;

    let mut this_week = DictationPeriodTotals::default();
    let mut last_week = DictationPeriodTotals::default();

    for row in rows {
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
        let wpm = row.wpm.map(|w| w.max(0) as u64);
        if let Some(w) = wpm {
            total_wpm_sum += w;
            wpm_count += 1;
            fastest_wpm = fastest_wpm.max(u32::try_from(w).unwrap_or(u32::MAX));
        }

        // Duration
        if let Some(d) = row.duration_seconds {
            total_duration += d;
            if d > longest_session_seconds {
                longest_session_seconds = d;
            }
        }

        // Sentiment. NULL rows are excluded everywhere rather than substituted
        // with a fallback score; see `DictationSentimentCoverage`.
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
        // module docs.
        let hour = row.timestamp.find('T').and_then(|t_pos| {
            row.timestamp
                .get(t_pos + 1..t_pos + 3)
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|hour| *hour < 24)
        });
        if let Some(hour) = hour {
            hourly_activity[hour] += 1;
            if let Some(w) = wpm {
                wpm_by_hour_sum[hour] += w;
                wpm_by_hour_count[hour] += 1;
            }
        }

        // Day for streak calculation (YYYY-MM-DD)
        let day_key = row.timestamp.get(..10);
        if let Some(day) = day_key {
            days_with_entries.insert(day.to_string());
        }
        let day_index = day_key.and_then(parse_day_key);

        if let Some(day_index) = day_index {
            if let Some(hour) = hour {
                activity_matrix[day_of_week(day_index)][hour] += 1;
            }

            let acc = day_acc.entry(day_index).or_default();
            acc.entries += 1;
            acc.words += wc;
            acc.duration += row.duration_seconds.unwrap_or(0.0);
            if let Some(w) = wpm {
                acc.wpm_sum += w;
                acc.wpm_count += 1;
            }
            if let Some(s) = row.sentiment {
                acc.sentiment_sum += s;
                acc.sentiment_count += 1;
            }

            let period = if day_index >= start_of_this_week {
                Some(&mut this_week)
            } else if day_index >= start_of_last_week {
                Some(&mut last_week)
            } else {
                None
            };
            if let Some(period) = period {
                period.words = period
                    .words
                    .saturating_add(u32::try_from(wc).unwrap_or(u32::MAX));
                period.sessions += 1;
                period.duration_seconds += row.duration_seconds.unwrap_or(0.0);
            }
        }

        // Sentences — rough split on terminal punctuation, at least one per entry.
        let sentences = row
            .text
            .split(['.', '!', '?'])
            .filter(|s| !s.trim().is_empty())
            .count();
        total_sentences += sentences.max(1) as u64;

        // Tokenize once and reuse for every text-derived counter below.
        let tokens = tokenize(&row.text);
        token_count += tokens.len() as u64;

        for token in &tokens {
            let chars = token.chars().count();

            // NOTE: `token.len()` (bytes) rather than `chars` is deliberate here
            // — it is the pre-existing `topWords` behaviour and changing it
            // would shift a field the current UI already renders.
            if token.len() > 2 && !stopwords.contains(token.as_str()) {
                *word_freq.entry(token.clone()).or_insert(0) += 1;
            }

            if chars <= 3 {
                word_lengths.short += 1;
            } else if chars <= 6 {
                word_lengths.medium += 1;
            } else {
                word_lengths.long += 1;
            }

            total_syllables += count_syllables(token) as u64;

            if let Some(index) = filler_index.get(token.as_str()) {
                filler_counts[*index] += 1;
            }

            if chars > 3 && !common_words.contains(token.as_str()) {
                *rare_word_counts.entry(token.clone()).or_insert(0) += 1;
            }

            // First-seen tracking drives both vocabulary growth and
            // new-words-this-week. Rows arrive in ascending timestamp order, so
            // the first insertion of a word is its true first use.
            let first_seen = unique_words.insert(token.clone());
            if first_seen && chars > 2 {
                if let Some(day_index) = day_index {
                    day_acc.entry(day_index).or_default().new_words += 1;
                    if day_index >= start_of_this_week {
                        new_words_this_week_count += 1;
                        if new_words_this_week.len() < NEW_WORDS_SAMPLE_LIMIT {
                            new_words_this_week.push(token.clone());
                        }
                    }
                }
            }
        }

        for window in tokens.windows(2) {
            *bigrams
                .entry(format!("{} {}", window[0], window[1]))
                .or_insert(0) += 1;
        }
        for window in tokens.windows(3) {
            *trigrams
                .entry(format!("{} {} {}", window[0], window[1], window[2]))
                .or_insert(0) += 1;
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
    let time_saved_minutes = (total_words as f64 / TYPING_WPM_BASELINE) - (total_duration / 60.0);

    let average_sentiment = if sentiment_count > 0 {
        sentiment_sum / sentiment_count as f64
    } else {
        0.0
    };

    let total_duration_minutes = total_duration / 60.0;

    // ---- daily series ----------------------------------------------------
    let mut day_indices: Vec<i64> = day_acc.keys().copied().collect();
    day_indices.sort_unstable();

    let mut max_words_in_day: u32 = 0;
    let mut vocab_running: u32 = 0;
    let mut scored_days: u32 = 0;
    let mut full_series: Vec<DictationDailyPoint> = Vec::with_capacity(day_indices.len());
    for day_index in &day_indices {
        let acc = &day_acc[day_index];
        vocab_running = vocab_running.saturating_add(acc.new_words);
        let words = u32::try_from(acc.words).unwrap_or(u32::MAX);
        max_words_in_day = max_words_in_day.max(words);
        if acc.sentiment_count > 0 {
            scored_days += 1;
        }
        full_series.push(DictationDailyPoint {
            date: format_day_key(*day_index),
            entries: acc.entries,
            words,
            duration_seconds: acc.duration,
            avg_wpm: if acc.wpm_count > 0 {
                Some((acc.wpm_sum as f64 / acc.wpm_count as f64).round() as u32)
            } else {
                None
            },
            vocab_size: vocab_running,
            avg_sentiment: if acc.sentiment_count > 0 {
                Some(acc.sentiment_sum / acc.sentiment_count as f64)
            } else {
                None
            },
        });
    }

    let carry_len = full_series.len().saturating_sub(DAILY_SERIES_MAX_DAYS);
    let mut daily_series_carry = DictationDailyCarry {
        days: carry_len as u32,
        words: 0,
        duration_seconds: 0.0,
        time_saved_minutes: 0.0,
    };
    for point in &full_series[..carry_len] {
        daily_series_carry.words = daily_series_carry.words.saturating_add(point.words);
        daily_series_carry.duration_seconds += point.duration_seconds;
        daily_series_carry.time_saved_minutes += day_time_saved_minutes(point);
    }
    let daily_series: Vec<DictationDailyPoint> = full_series.split_off(carry_len);

    let today_words = day_acc
        .get(&today)
        .map(|acc| u32::try_from(acc.words).unwrap_or(u32::MAX))
        .unwrap_or(0);

    // ---- streaks ---------------------------------------------------------
    let (current_streak, longest_streak) = compute_streaks(&day_indices, today);

    // ---- WPM by hour -----------------------------------------------------
    let mut wpm_by_hour = [None; 24];
    for hour in 0..24 {
        if wpm_by_hour_count[hour] > 0 {
            wpm_by_hour[hour] = Some(
                (wpm_by_hour_sum[hour] as f64 / wpm_by_hour_count[hour] as f64).round() as u32,
            );
        }
    }

    // ---- phrases & rare words -------------------------------------------
    let top_bigrams = top_phrases(bigrams, &phrase_stopwords, TOP_BIGRAMS);
    let top_trigrams = top_phrases(trigrams, &phrase_stopwords, TOP_TRIGRAMS);

    let mut rare_words: Vec<(String, u32)> = rare_word_counts
        .into_iter()
        .filter(|(_, count)| *count >= MIN_PHRASE_COUNT)
        .collect();
    sort_by_count_then_text(&mut rare_words);
    rare_words.truncate(TOP_RARE_WORDS);

    // ---- reading level ---------------------------------------------------
    let reading_level = flesch_kincaid(token_count, total_sentences, total_syllables);

    DictationAnalytics {
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
        activity_matrix,
        wpm_by_hour,
        daily_series,
        daily_series_carry,
        current_streak,
        longest_streak,
        max_words_in_day,
        longest_session_seconds,
        today_words,
        daily_word_goal: DAILY_WORD_GOAL,
        weekly_word_goal: WEEKLY_WORD_GOAL,
        this_week,
        last_week,
        filler_counts: FILLER_WORDS
            .iter()
            .zip(filler_counts)
            .map(|(word, count)| ((*word).to_string(), count))
            .collect(),
        top_bigrams,
        top_trigrams,
        rare_words,
        word_lengths,
        reading_level,
        new_words_this_week,
        new_words_this_week_count,
        sentiment_coverage: DictationSentimentCoverage {
            scored_entries: sentiment_count,
            total_entries,
            scored_days,
        },
    }
}

/// Minutes saved on a day versus typing at [`TYPING_WPM_BASELINE`], never
/// negative. Mirrors upstream's `timeSavedToday`; the frontend applies the same
/// formula per point, so it is not shipped per-day.
fn day_time_saved_minutes(point: &DictationDailyPoint) -> f64 {
    let saved = point.words as f64 / TYPING_WPM_BASELINE - point.duration_seconds / 60.0;
    if saved > 0.0 {
        saved
    } else {
        0.0
    }
}

/// Split text into lowercased alphanumeric tokens.
///
/// Matches the tokenizer the pre-existing `topWords` derivation used: split on
/// whitespace, drop every non-alphanumeric character, lowercase. It is slightly
/// more aggressive than upstream's punctuation-only strip (`well-known` becomes
/// `wellknown` here, `well-known` there), but using one tokenizer for every
/// derivation keeps `topWords`, n-grams and vocabulary counts consistent with
/// each other.
fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
                .to_lowercase()
        })
        .filter(|token| !token.is_empty())
        .collect()
}

/// Approximate syllable count. Direct port of upstream's `countSyllables`,
/// expressed without a regex engine (`src-tauri` has no `regex` dependency).
fn count_syllables(word: &str) -> u32 {
    const VOWELS: [char; 6] = ['a', 'e', 'i', 'o', 'u', 'y'];
    /// The `[^laeiouy]` character class from upstream's suffix regex.
    fn is_suffix_guard(c: char) -> bool {
        !matches!(c, 'l' | 'a' | 'e' | 'i' | 'o' | 'u' | 'y')
    }

    let lower = word.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    if chars.len() <= 3 {
        return 1;
    }

    // `/(?:[^laeiouy]es|ed|[^laeiouy]e)$/` — leftmost-first alternation, so the
    // three-character `[^laeiouy]es` arm wins when it also matches at the end of
    // the word; the `ed` and `[^laeiouy]e` arms both start two back and both
    // strip two, so they collapse into one branch here.
    let n = chars.len();
    let strips_three = chars[n - 2] == 'e' && chars[n - 1] == 's' && is_suffix_guard(chars[n - 3]);
    let strips_two = (chars[n - 2] == 'e' && chars[n - 1] == 'd')
        || (chars[n - 1] == 'e' && is_suffix_guard(chars[n - 2]));
    let end = if strips_three {
        n - 3
    } else if strips_two {
        n - 2
    } else {
        n
    };

    // `/^y/`
    let start = if end > 0 && chars[0] == 'y' { 1 } else { 0 };

    // `/[aeiouy]{1,2}/g` — greedy, non-overlapping.
    let mut count = 0u32;
    let mut i = start;
    while i < end {
        if VOWELS.contains(&chars[i]) {
            count += 1;
            i += 1;
            if i < end && VOWELS.contains(&chars[i]) {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    if count == 0 {
        1
    } else {
        count
    }
}

/// Flesch-Kincaid grade level, clamped to `1..=18` as upstream does.
fn flesch_kincaid(words: u64, sentences: u64, syllables: u64) -> f64 {
    if words == 0 {
        return 0.0;
    }
    let avg_words_per_sentence = if sentences > 0 {
        words as f64 / sentences as f64
    } else {
        0.0
    };
    let avg_syllables_per_word = syllables as f64 / words as f64;
    let raw = 0.39 * avg_words_per_sentence + 11.8 * avg_syllables_per_word - 15.59;
    raw.clamp(1.0, 18.0)
}

/// Keep phrases seen at least twice that are not made up entirely of stopwords,
/// ordered by count descending then phrase ascending.
fn top_phrases(
    counts: HashMap<String, u32>,
    stopwords: &HashSet<&str>,
    limit: usize,
) -> Vec<(String, u32)> {
    let mut kept: Vec<(String, u32)> = counts
        .into_iter()
        .filter(|(phrase, count)| {
            *count >= MIN_PHRASE_COUNT && !phrase.split(' ').all(|word| stopwords.contains(word))
        })
        .collect();
    sort_by_count_then_text(&mut kept);
    kept.truncate(limit);
    kept
}

/// Deterministic ordering for top-N lists built out of a `HashMap`, whose
/// iteration order is randomized per process.
fn sort_by_count_then_text(items: &mut [(String, u32)]) {
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
}

/// `(current, longest)` streak lengths over a sorted, deduplicated list of UTC
/// day indices.
///
/// The current streak must reach `today` or yesterday, matching upstream — a run
/// that ended a week ago is history, not a streak. `dailyStreak` keeps the older
/// "run ending at the last active day" definition.
fn compute_streaks(sorted_days: &[i64], today: i64) -> (u32, u32) {
    if sorted_days.is_empty() {
        return (0, 0);
    }

    let mut longest = 1u32;
    let mut run = 1u32;
    for pair in sorted_days.windows(2) {
        if pair[1] - pair[0] == 1 {
            run += 1;
        } else {
            run = 1;
        }
        longest = longest.max(run);
    }

    let present: HashSet<i64> = sorted_days.iter().copied().collect();
    let anchor = if present.contains(&today) {
        Some(today)
    } else if present.contains(&(today - 1)) {
        Some(today - 1)
    } else {
        None
    };

    let current = match anchor {
        Some(anchor) => {
            let mut streak = 1u32;
            let mut day = anchor - 1;
            while present.contains(&day) {
                streak += 1;
                day -= 1;
            }
            streak
        }
        None => 0,
    };

    (current, longest)
}

/// UTC day index (days since 1970-01-01) for right now.
fn current_day_index() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86400) as i64)
        .unwrap_or(0)
}

/// Day of week for a day index, `0 = Sunday`, matching `Date#getDay()`.
/// 1970-01-01 (index 0) was a Thursday.
fn day_of_week(day_index: i64) -> usize {
    (day_index + 4).rem_euclid(7) as usize
}

/// Parse a `YYYY-MM-DD` key into a day index, or `None` if it is malformed.
fn parse_day_key(key: &str) -> Option<i64> {
    let bytes = key.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = key.get(0..4)?.parse().ok()?;
    let month: u32 = key.get(5..7)?.parse().ok()?;
    let day: u32 = key.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn format_day_key(day_index: i64) -> String {
    let (year, month, day) = civil_from_days(day_index);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant's `days_from_civil`. Proleptic Gregorian, no tz involved.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = if month > 2 {
        month as i64 - 3
    } else {
        month as i64 + 9
    };
    let day_of_year = (153 * month_prime + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`].
fn civil_from_days(day_index: i64) -> (i64, u32, u32) {
    let z = day_index + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
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

    fn entry(timestamp: &str, text: &str) -> EntryRow {
        EntryRow {
            text: text.to_string(),
            mode: "transcribe".to_string(),
            timestamp: timestamp.to_string(),
            word_count: Some(text.split_whitespace().count() as i64),
            duration_seconds: Some(10.0),
            wpm: Some(100),
            sentiment: None,
        }
    }

    fn day(key: &str) -> i64 {
        parse_day_key(key).expect("test date must parse")
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

    // ---------------------------------------------------------------
    // Calendar helpers
    // ---------------------------------------------------------------

    #[test]
    fn civil_day_conversion_round_trips_across_boundaries() {
        assert_eq!(day("1970-01-01"), 0);
        assert_eq!(day("1970-01-02"), 1);
        assert_eq!(day("1969-12-31"), -1);
        // Leap-day handling in both directions.
        assert_eq!(day("2024-03-01") - day("2024-02-28"), 2);
        assert_eq!(day("2025-03-01") - day("2025-02-28"), 1);
        // Century rule: 2100 is not a leap year.
        assert_eq!(day("2100-03-01") - day("2100-02-28"), 1);

        for key in [
            "1970-01-01",
            "1999-12-31",
            "2000-02-29",
            "2026-08-27",
            "2100-03-01",
        ] {
            assert_eq!(format_day_key(day(key)), key);
        }
    }

    #[test]
    fn day_of_week_is_sunday_indexed() {
        // 1970-01-01 was a Thursday.
        assert_eq!(day_of_week(day("1970-01-01")), 4);
        // 2026-08-27 is a Thursday; 2026-08-30 a Sunday.
        assert_eq!(day_of_week(day("2026-08-27")), 4);
        assert_eq!(day_of_week(day("2026-08-30")), 0);
        assert_eq!(day_of_week(day("2026-08-31")), 1);
        // Pre-epoch indices must not go negative through `%`.
        assert_eq!(day_of_week(day("1969-12-28")), 0);
    }

    #[test]
    fn malformed_day_keys_do_not_parse() {
        for key in [
            "2026-08-2",
            "2026/08/27",
            "20260827",
            "2026-13-01",
            "2026-08-32",
            "2026-00-10",
            "",
            "短い日付です",
        ] {
            assert!(parse_day_key(key).is_none(), "unexpectedly parsed {key:?}");
        }
    }

    // ---------------------------------------------------------------
    // Streaks
    // ---------------------------------------------------------------

    #[test]
    fn current_streak_spans_a_gap_and_a_month_boundary() {
        let today = day("2026-09-02");
        let days = vec![
            day("2026-08-10"),
            day("2026-08-11"),
            // gap
            day("2026-08-30"),
            day("2026-08-31"),
            day("2026-09-01"),
            day("2026-09-02"),
        ];
        // The run across 08-31 → 09-01 must not be broken by the month rollover.
        assert_eq!(compute_streaks(&days, today), (4, 4));
    }

    #[test]
    fn current_streak_tolerates_yesterday_but_not_two_days_ago() {
        let days = vec![day("2026-08-25"), day("2026-08-26"), day("2026-08-27")];
        // Anchored on today.
        assert_eq!(compute_streaks(&days, day("2026-08-27")).0, 3);
        // Anchored on yesterday — still counts, matching upstream.
        assert_eq!(compute_streaks(&days, day("2026-08-28")).0, 3);
        // Two days stale — the streak is over, but the record survives.
        assert_eq!(compute_streaks(&days, day("2026-08-29")), (0, 3));
    }

    #[test]
    fn longest_streak_picks_the_longest_run_not_the_last() {
        let days = vec![
            day("2026-01-01"),
            day("2026-01-02"),
            day("2026-01-03"),
            day("2026-01-04"),
            day("2026-06-01"),
            day("2026-06-02"),
        ];
        assert_eq!(compute_streaks(&days, day("2026-06-02")), (2, 4));
        assert_eq!(compute_streaks(&[], day("2026-06-02")), (0, 0));
        assert_eq!(
            compute_streaks(&[day("2026-06-02")], day("2026-06-02")),
            (1, 1)
        );
    }

    #[test]
    fn streaks_cross_the_year_boundary() {
        let days = vec![
            day("2026-12-30"),
            day("2026-12-31"),
            day("2027-01-01"),
            day("2027-01-02"),
        ];
        assert_eq!(compute_streaks(&days, day("2027-01-02")), (4, 4));
    }

    // ---------------------------------------------------------------
    // Text derivations
    // ---------------------------------------------------------------

    #[test]
    fn syllable_counting_matches_the_upstream_heuristic() {
        // <= 3 characters is always one syllable.
        assert_eq!(count_syllables("a"), 1);
        assert_eq!(count_syllables("cat"), 1);
        // Vowel-group counting.
        assert_eq!(count_syllables("hello"), 2);
        assert_eq!(count_syllables("banana"), 3);
        assert_eq!(count_syllables("computer"), 3);
        // Silent-e suffix stripping: `[^laeiouy]e$`.
        assert_eq!(count_syllables("code"), 1);
        assert_eq!(count_syllables("stone"), 1);
        // `le` is protected by the `[^laeiouy]` guard.
        assert_eq!(count_syllables("table"), 2);
        // `ed$` stripping.
        assert_eq!(count_syllables("walked"), 1);
        // `[^laeiouy]es$` stripping.
        assert_eq!(count_syllables("codes"), 1);
        // `y` is in the vowel class, so this scores one rather than zero.
        assert_eq!(count_syllables("rhythms"), 1);
        // Nothing in the vowel class at all still floors at one.
        assert_eq!(count_syllables("blkchn"), 1);
        // Leading `y` is dropped before counting.
        assert_eq!(count_syllables("yellow"), 2);
    }

    #[test]
    fn flesch_kincaid_matches_a_hand_computed_sample() {
        // 0.39 * (100/10) + 11.8 * (150/100) - 15.59
        //   = 3.9 + 17.7 - 15.59 = 6.01
        let score = flesch_kincaid(100, 10, 150);
        assert!((score - 6.01).abs() < 1e-9, "got {score}");

        // Clamped low: very short sentences of monosyllables.
        // 0.39 * 1 + 11.8 * 1 - 15.59 = -3.4 → 1.0
        assert_eq!(flesch_kincaid(10, 10, 10), 1.0);

        // Clamped high: 0.39 * 100 + 11.8 * 4 - 15.59 = 70.61 → 18.0
        assert_eq!(flesch_kincaid(100, 1, 400), 18.0);

        // Empty corpus divides by nothing.
        assert_eq!(flesch_kincaid(0, 0, 0), 0.0);
        assert_eq!(flesch_kincaid(0, 5, 5), 0.0);
    }

    #[test]
    fn word_length_distribution_buckets_by_character_count() {
        let rows = vec![entry(
            "2026-08-27T10:00:00Z",
            "a to cat four words medium sevench longestword",
        )];
        let analytics = compute_analytics(&rows, day("2026-08-27"));
        // 1-3: a, to, cat        4-6: four, words, medium
        // 7+ : sevench, longestword
        assert_eq!(analytics.word_lengths.short, 3);
        assert_eq!(analytics.word_lengths.medium, 3);
        assert_eq!(analytics.word_lengths.long, 2);
    }

    #[test]
    fn bigrams_and_trigrams_need_two_sightings_and_a_non_stopword() {
        let rows = vec![
            entry("2026-08-27T10:00:00Z", "deploy the sidecar build now"),
            entry("2026-08-27T11:00:00Z", "deploy the sidecar build again"),
            // "of the" repeats but is entirely stopwords, so it is dropped.
            entry("2026-08-27T12:00:00Z", "of the of the"),
        ];
        let analytics = compute_analytics(&rows, day("2026-08-27"));

        let bigrams: Vec<&str> = analytics
            .top_bigrams
            .iter()
            .map(|(p, _)| p.as_str())
            .collect();
        assert!(bigrams.contains(&"deploy the"));
        assert!(bigrams.contains(&"the sidecar"));
        assert!(bigrams.contains(&"sidecar build"));
        assert!(!bigrams.contains(&"of the"), "all-stopword phrase leaked");
        // "build now" and "build again" appear once each.
        assert!(!bigrams.contains(&"build now"));
        assert_eq!(
            analytics
                .top_bigrams
                .iter()
                .find(|(p, _)| p == "deploy the")
                .map(|(_, c)| *c),
            Some(2)
        );

        let trigrams: Vec<&str> = analytics
            .top_trigrams
            .iter()
            .map(|(p, _)| p.as_str())
            .collect();
        assert!(trigrams.contains(&"deploy the sidecar"));
        assert!(trigrams.contains(&"the sidecar build"));
        assert!(!trigrams.contains(&"sidecar build now"));
        // Sorted by count desc, then phrase asc.
        assert!(analytics.top_trigrams.windows(2).all(|w| w[0].1 >= w[1].1));
    }

    #[test]
    fn rare_words_exclude_common_and_single_use_words() {
        let rows = vec![
            entry(
                "2026-08-27T10:00:00Z",
                "the quantization kernel handles code",
            ),
            entry(
                "2026-08-27T11:00:00Z",
                "quantization again with kernel and code",
            ),
            entry("2026-08-27T12:00:00Z", "singleton"),
        ];
        let analytics = compute_analytics(&rows, day("2026-08-27"));
        let rare: Vec<&str> = analytics
            .rare_words
            .iter()
            .map(|(w, _)| w.as_str())
            .collect();

        assert!(rare.contains(&"quantization"));
        assert!(rare.contains(&"kernel"));
        // In COMMON_WORDS despite appearing twice.
        assert!(!rare.contains(&"code"));
        // Only seen once.
        assert!(!rare.contains(&"singleton"));
        // Three characters or fewer never qualify.
        assert!(!rare.contains(&"the"));
    }

    #[test]
    fn week_comparison_splits_on_the_sunday_boundary() {
        // 2026-08-30 is a Sunday, so the week containing 2026-09-02 starts there
        // and the previous week runs 2026-08-23..2026-08-29.
        let today = day("2026-09-02");
        let rows = vec![
            // Last week's first day.
            entry("2026-08-23T09:00:00Z", "alpha beta"),
            // Last week's last day.
            entry("2026-08-29T23:59:59Z", "gamma delta epsilon"),
            // This week's first day.
            entry("2026-08-30T00:00:00Z", "zeta"),
            entry("2026-09-02T08:00:00Z", "eta theta"),
            // Two weeks back — in neither bucket.
            entry("2026-08-22T08:00:00Z", "iota kappa lambda mu"),
        ];
        let analytics = compute_analytics(&rows, today);

        assert_eq!(analytics.this_week.sessions, 2);
        assert_eq!(analytics.this_week.words, 3);
        assert_eq!(analytics.last_week.sessions, 2);
        assert_eq!(analytics.last_week.words, 5);
        assert!((analytics.this_week.duration_seconds - 20.0).abs() < 1e-9);

        // Today's goal bucket is the UTC day, not the week.
        assert_eq!(analytics.today_words, 2);
        assert_eq!(analytics.daily_word_goal, DAILY_WORD_GOAL);
        assert_eq!(analytics.weekly_word_goal, WEEKLY_WORD_GOAL);
    }

    #[test]
    fn new_words_this_week_excludes_words_first_used_earlier() {
        let today = day("2026-09-02");
        let rows = vec![
            entry("2026-08-20T10:00:00Z", "sidecar orchestrator"),
            entry("2026-08-31T10:00:00Z", "sidecar worktree"),
        ];
        let analytics = compute_analytics(&rows, today);
        assert_eq!(analytics.new_words_this_week, vec!["worktree".to_string()]);
        assert_eq!(analytics.new_words_this_week_count, 1);
    }

    // ---------------------------------------------------------------
    // Series assembly
    // ---------------------------------------------------------------

    #[test]
    fn daily_series_carries_vocabulary_and_sentiment() {
        let today = day("2026-08-28");
        let mut rows = vec![
            entry("2026-08-26T10:00:00Z", "alpha beta gamma"),
            entry("2026-08-27T10:00:00Z", "alpha beta delta"),
            entry("2026-08-28T10:00:00Z", "epsilon"),
        ];
        rows[0].sentiment = Some(0.5);
        rows[1].sentiment = None;
        rows[2].sentiment = Some(-0.25);

        let analytics = compute_analytics(&rows, today);
        assert_eq!(analytics.daily_series.len(), 3);
        assert_eq!(analytics.daily_series_carry.days, 0);

        let dates: Vec<&str> = analytics
            .daily_series
            .iter()
            .map(|p| p.date.as_str())
            .collect();
        assert_eq!(dates, ["2026-08-26", "2026-08-27", "2026-08-28"]);

        // Cumulative distinct words: 3, then +delta, then +epsilon.
        let vocab: Vec<u32> = analytics
            .daily_series
            .iter()
            .map(|p| p.vocab_size)
            .collect();
        assert_eq!(vocab, [3, 4, 5]);

        // A day whose only entry is unscored has no sentiment point at all —
        // it is not averaged in as a neutral zero.
        assert_eq!(analytics.daily_series[0].avg_sentiment, Some(0.5));
        assert_eq!(analytics.daily_series[1].avg_sentiment, None);
        assert_eq!(analytics.daily_series[2].avg_sentiment, Some(-0.25));

        assert_eq!(analytics.sentiment_coverage.scored_entries, 2);
        assert_eq!(analytics.sentiment_coverage.total_entries, 3);
        assert_eq!(analytics.sentiment_coverage.scored_days, 2);
        // The mean covers scored rows only: (0.5 + -0.25) / 2.
        assert!((analytics.average_sentiment - 0.125).abs() < 1e-9);
    }

    #[test]
    fn daily_series_is_bounded_and_older_days_fold_into_the_carry() {
        let start = day("2024-01-01");
        let span = DAILY_SERIES_MAX_DAYS + 30;
        let rows: Vec<EntryRow> = (0..span)
            .map(|offset| {
                let stamp = format!("{}T10:00:00Z", format_day_key(start + offset as i64));
                let mut row = entry(&stamp, "one two three four");
                // 4 words at 40 wpm = 6s of typing; 1s of speech leaves 5s saved.
                row.duration_seconds = Some(1.0);
                row
            })
            .collect();

        let analytics = compute_analytics(&rows, start + span as i64 - 1);
        assert_eq!(analytics.daily_series.len(), DAILY_SERIES_MAX_DAYS);
        assert_eq!(analytics.daily_series_carry.days, 30);
        assert_eq!(analytics.daily_series_carry.words, 30 * 4);
        assert!((analytics.daily_series_carry.duration_seconds - 30.0).abs() < 1e-9);
        // Per day: 4/40 min typing - 1/60 min speaking.
        let per_day = 4.0 / 40.0 - 1.0 / 60.0;
        assert!(
            (analytics.daily_series_carry.time_saved_minutes - 30.0 * per_day).abs() < 1e-9,
            "got {}",
            analytics.daily_series_carry.time_saved_minutes
        );
        // The window keeps the newest days.
        let newest = format_day_key(start + span as i64 - 1);
        assert_eq!(
            analytics.daily_series.last().map(|p| p.date.clone()),
            Some(newest)
        );
        let oldest_kept = format_day_key(start + 30);
        assert_eq!(
            analytics.daily_series.first().map(|p| p.date.clone()),
            Some(oldest_kept)
        );
    }

    #[test]
    fn activity_matrix_columns_sum_to_hourly_activity() {
        let rows = vec![
            entry("2026-08-27T09:00:00Z", "thursday morning"),
            entry("2026-08-27T09:30:00Z", "thursday morning again"),
            entry("2026-08-30T21:00:00Z", "sunday night"),
        ];
        let analytics = compute_analytics(&rows, day("2026-08-30"));

        assert_eq!(analytics.activity_matrix[4][9], 2); // Thursday 09:00 UTC
        assert_eq!(analytics.activity_matrix[0][21], 1); // Sunday 21:00 UTC

        for hour in 0..24 {
            let column: u32 = (0..7).map(|dow| analytics.activity_matrix[dow][hour]).sum();
            assert_eq!(
                column, analytics.hourly_activity[hour],
                "hour {hour} disagrees"
            );
        }

        // WPM-by-hour only has points where entries exist.
        assert_eq!(analytics.wpm_by_hour[9], Some(100));
        assert_eq!(analytics.wpm_by_hour[0], None);
    }

    #[test]
    fn records_and_streaks_come_through_the_full_reduction() {
        let today = day("2026-08-28");
        let mut rows = vec![
            entry("2026-08-27T10:00:00Z", "one two three"),
            entry("2026-08-28T10:00:00Z", "four five"),
        ];
        rows[0].wpm = Some(130);
        rows[0].duration_seconds = Some(42.5);
        rows[1].wpm = Some(90);
        rows[1].duration_seconds = Some(9.0);

        let analytics = compute_analytics(&rows, today);
        assert_eq!(analytics.fastest_wpm, 130);
        assert_eq!(analytics.max_words_in_day, 3);
        assert!((analytics.longest_session_seconds - 42.5).abs() < 1e-9);
        assert_eq!(analytics.current_streak, 2);
        assert_eq!(analytics.longest_streak, 2);
        assert_eq!(
            analytics.filler_counts.len(),
            FILLER_WORDS.len(),
            "every filler word is reported, zeros included"
        );
    }

    #[test]
    fn filler_words_are_counted_per_token_in_a_fixed_order() {
        let rows = vec![entry(
            "2026-08-27T10:00:00Z",
            "um so like um basically it works right",
        )];
        let analytics = compute_analytics(&rows, day("2026-08-27"));
        let counts: HashMap<&str, u32> = analytics
            .filler_counts
            .iter()
            .map(|(w, c)| (w.as_str(), *c))
            .collect();
        assert_eq!(counts["um"], 2);
        assert_eq!(counts["so"], 1);
        assert_eq!(counts["like"], 1);
        assert_eq!(counts["basically"], 1);
        assert_eq!(counts["right"], 1);
        assert_eq!(counts["honestly"], 0);
        // Order is the declaration order of FILLER_WORDS.
        let order: Vec<&str> = analytics
            .filler_counts
            .iter()
            .map(|(w, _)| w.as_str())
            .collect();
        assert_eq!(order, FILLER_WORDS.to_vec());
    }

    // ---------------------------------------------------------------
    // Degenerate inputs
    // ---------------------------------------------------------------

    #[test]
    fn an_empty_database_divides_by_nothing() {
        let analytics = compute_analytics(&[], day("2026-08-27"));
        assert_eq!(analytics.total_entries, 0);
        assert_eq!(analytics.total_words, 0);
        assert_eq!(analytics.average_wpm, 0);
        assert_eq!(analytics.vocabulary_diversity, 0.0);
        assert_eq!(analytics.average_sentiment, 0.0);
        assert_eq!(analytics.reading_level, 0.0);
        assert_eq!(analytics.time_saved_minutes, 0.0);
        assert_eq!(analytics.current_streak, 0);
        assert_eq!(analytics.longest_streak, 0);
        assert_eq!(analytics.daily_streak, 0);
        assert_eq!(analytics.max_words_in_day, 0);
        assert_eq!(analytics.longest_session_seconds, 0.0);
        assert_eq!(analytics.today_words, 0);
        assert!(analytics.daily_series.is_empty());
        assert_eq!(analytics.daily_series_carry.days, 0);
        assert!(analytics.top_bigrams.is_empty());
        assert!(analytics.top_trigrams.is_empty());
        assert!(analytics.rare_words.is_empty());
        assert!(analytics.new_words_this_week.is_empty());
        assert_eq!(analytics.this_week, DictationPeriodTotals::default());
        assert_eq!(analytics.last_week, DictationPeriodTotals::default());
        assert_eq!(analytics.word_lengths, DictationWordLengths::default());
        assert_eq!(analytics.wpm_by_hour, [None; 24]);
        assert_eq!(
            analytics.sentiment_coverage,
            DictationSentimentCoverage::default()
        );
        // Still serializable — the frontend always gets a full object.
        assert!(serde_json::to_string(&analytics).is_ok());
    }

    /// The frontend builds against `src/types/dictation.ts`. Pin the wire keys
    /// so a rename here fails here rather than silently in the UI.
    #[test]
    fn serialized_keys_match_the_typescript_interface() {
        let mut rows = vec![entry("2026-08-27T10:00:00Z", "alpha beta gamma")];
        rows[0].sentiment = Some(0.25);
        let json = serde_json::to_value(compute_analytics(&rows, day("2026-08-27")))
            .expect("analytics must serialize");

        let mut keys: Vec<&str> = json
            .as_object()
            .expect("payload is an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();

        let mut expected = vec![
            // Pre-existing.
            "totalEntries",
            "totalWords",
            "averageWpm",
            "fastestWpm",
            "averageSentiment",
            "totalDurationMinutes",
            "longestEntryWords",
            "hourlyActivity",
            "topWords",
            "modeBreakdown",
            "vocabularyDiversity",
            "dailyStreak",
            "timeSavedMinutes",
            // Added.
            "activityMatrix",
            "wpmByHour",
            "dailySeries",
            "dailySeriesCarry",
            "currentStreak",
            "longestStreak",
            "maxWordsInDay",
            "longestSessionSeconds",
            "todayWords",
            "dailyWordGoal",
            "weeklyWordGoal",
            "thisWeek",
            "lastWeek",
            "fillerCounts",
            "topBigrams",
            "topTrigrams",
            "rareWords",
            "wordLengths",
            "readingLevel",
            "newWordsThisWeek",
            "newWordsThisWeekCount",
            "sentimentCoverage",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);

        let nested_keys = |value: &serde_json::Value| -> Vec<String> {
            let mut keys: Vec<String> = value
                .as_object()
                .expect("nested value is an object")
                .keys()
                .cloned()
                .collect();
            keys.sort();
            keys
        };
        assert_eq!(
            nested_keys(&json["dailySeries"][0]),
            [
                "avgSentiment",
                "avgWpm",
                "date",
                "durationSeconds",
                "entries",
                "vocabSize",
                "words"
            ]
        );
        assert_eq!(
            nested_keys(&json["dailySeriesCarry"]),
            ["days", "durationSeconds", "timeSavedMinutes", "words"]
        );
        assert_eq!(
            nested_keys(&json["thisWeek"]),
            ["durationSeconds", "sessions", "words"]
        );
        assert_eq!(
            nested_keys(&json["wordLengths"]),
            ["long", "medium", "short"]
        );
        assert_eq!(
            nested_keys(&json["sentimentCoverage"]),
            ["scoredDays", "scoredEntries", "totalEntries"]
        );

        // Fixed-width arrays stay fixed width.
        assert_eq!(json["hourlyActivity"].as_array().unwrap().len(), 24);
        assert_eq!(json["wpmByHour"].as_array().unwrap().len(), 24);
        let matrix = json["activityMatrix"].as_array().unwrap();
        assert_eq!(matrix.len(), 7);
        assert!(matrix.iter().all(|row| row.as_array().unwrap().len() == 24));
    }

    #[test]
    fn a_single_entry_produces_finite_averages() {
        let rows = vec![entry("2026-08-27T10:00:00Z", "hello world")];
        let analytics = compute_analytics(&rows, day("2026-08-27"));
        assert_eq!(analytics.total_entries, 1);
        assert_eq!(analytics.daily_series.len(), 1);
        assert_eq!(analytics.daily_series[0].entries, 1);
        assert_eq!(analytics.daily_series[0].avg_wpm, Some(100));
        assert_eq!(analytics.daily_series[0].avg_sentiment, None);
        assert_eq!(analytics.current_streak, 1);
        assert_eq!(analytics.longest_streak, 1);
        assert!(analytics.reading_level.is_finite());
        assert!(analytics.reading_level >= 1.0);
        // No phrase can reach the two-sighting threshold.
        assert!(analytics.top_bigrams.is_empty());
        assert_eq!(analytics.sentiment_coverage.scored_entries, 0);
        assert_eq!(analytics.sentiment_coverage.total_entries, 1);
        assert_eq!(analytics.average_sentiment, 0.0);
    }

    #[test]
    fn rows_with_unparseable_timestamps_are_kept_out_of_calendar_buckets() {
        let rows = vec![
            entry("not-a-timestamp", "orphaned entry text"),
            entry("2026-08-27T10:00:00Z", "real entry text"),
        ];
        let analytics = compute_analytics(&rows, day("2026-08-27"));
        // Corpus-wide counters still see both rows...
        assert_eq!(analytics.total_entries, 2);
        assert_eq!(analytics.total_words, 6);
        // ...but only the parseable one lands in a day-bucket.
        assert_eq!(analytics.daily_series.len(), 1);
        assert_eq!(analytics.daily_series[0].entries, 1);
        assert_eq!(analytics.today_words, 3);
    }
}
