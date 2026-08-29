export interface DictationEntry {
  id: number;
  text: string;
  mode: string;
  timestamp: string;
  wordCount: number | null;
  durationSeconds: number | null;
  wpm: number | null;
  sentiment: number | null;
}

/** One day-bucket of {@link DictationAnalytics.dailySeries}.
 *
 *  This single series backs seven charts — words/day, time saved, cumulative
 *  talking time, WPM over time, the yearly heatmap, vocabulary growth, and
 *  sentiment over time. Derive the rest on the client:
 *  - time saved that day = `Math.max(0, words / 40 - durationSeconds / 60)`
 *  - cumulative time saved / talking time = running sums of the above, seeded
 *    from {@link DictationAnalytics.dailySeriesCarry}
 *  - a date-keyed lookup for the heatmap = one `Map` built from this array
 *
 *  Only days with at least one entry appear. Dates are **UTC** `YYYY-MM-DD`,
 *  ascending. */
export interface DictationDailyPoint {
  date: string;
  entries: number;
  words: number;
  durationSeconds: number;
  /** Mean WPM that day, or null when no entry recorded a WPM. */
  avgWpm: number | null;
  /** Cumulative distinct words (longer than two characters) seen up to and
   *  including this day. Monotonic, so it stays correct when the series front
   *  is truncated. */
  vocabSize: number;
  /** Mean sentiment across the *scored* entries of the day, or null when none
   *  are scored. See {@link DictationAnalytics.sentimentCoverage}. */
  avgSentiment: number | null;
}

/** Totals for the day-buckets that fell outside the `dailySeries` window, so
 *  cumulative charts start from the right base instead of at zero. */
export interface DictationDailyCarry {
  /** Day-buckets folded in. 0 means `dailySeries` is complete. */
  days: number;
  words: number;
  durationSeconds: number;
  /** Sum of the per-day time saved for the folded days. Not derivable from the
   *  totals above — the per-day clamp at zero happens before summing. */
  timeSavedMinutes: number;
}

/** Totals over a calendar week (UTC, Sunday-start). */
export interface DictationPeriodTotals {
  words: number;
  sessions: number;
  durationSeconds: number;
}

/** Token counts by character length: 1-3, 4-6, 7+. */
export interface DictationWordLengths {
  short: number;
  medium: number;
  long: number;
}

/** How much of the corpus actually has a sentiment score.
 *
 *  `sentiment` was never written before the VADER scorer landed, so historical
 *  rows are null while new ones are scored. Every sentiment figure in the
 *  payload is computed over scored rows only. Use these counts to label the
 *  chart ("scored 12 of 840 entries") rather than presenting a partial mean as
 *  if it covered the whole history — and treat `averageSentiment` as "no data"
 *  rather than "neutral" when `scoredEntries` is 0. */
export interface DictationSentimentCoverage {
  scoredEntries: number;
  /** Equals `totalEntries`. */
  totalEntries: number;
  /** Day-buckets with at least one scored entry — how many points the sentiment
   *  series actually has. */
  scoredDays: number;
}

/** Payload of `get_dictation_analytics`. Mirrors the Rust `DictationAnalytics`
 *  in `src-tauri/src/commands/dictation/analytics.rs` field for field.
 *
 *  All calendar bucketing — hour, day, day-of-week, "today", "this week" — is
 *  **UTC**, because timestamps are stored UTC and the Rust side has no tz
 *  database.
 *
 *  Deliberately absent, do not re-add: a mode donut (PacketBench only ever
 *  writes the `transcribe` mode, so `modeBreakdown` is always one bucket) and
 *  topic classification (keyword rules tuned to a different product). */
export interface DictationAnalytics {
  totalEntries: number;
  totalWords: number;
  averageWpm: number;
  /** Doubles as the "best WPM" personal record. */
  fastestWpm: number;
  /** Mean over scored entries only; 0 when nothing is scored. Pair with
   *  `sentimentCoverage` before displaying. */
  averageSentiment: number;
  totalDurationMinutes: number;
  longestEntryWords: number;
  /** 24 entries. Column sum of `activityMatrix` — use directly for peak hours. */
  hourlyActivity: number[];
  topWords: [string, number][];
  /** Always a single `transcribe` bucket; nothing new should be built on it. */
  modeBreakdown: Record<string, number>;
  vocabularyDiversity: number;
  /** Consecutive days ending at the most recent day *with an entry*, however
   *  long ago. Distinct from `currentStreak`, which requires today/yesterday. */
  dailyStreak: number;
  timeSavedMinutes: number;

  /** `[dayOfWeek][hour]` session counts; row 0 is Sunday. 7 x 24, UTC. */
  activityMatrix: number[][];
  /** 24 entries: mean WPM per UTC hour, null where there is no data. */
  wpmByHour: (number | null)[];

  /** At most 365 trailing day-buckets, ascending, days with entries only. */
  dailySeries: DictationDailyPoint[];
  dailySeriesCarry: DictationDailyCarry;

  /** Consecutive days ending today or yesterday; 0 if neither has an entry. */
  currentStreak: number;
  longestStreak: number;
  maxWordsInDay: number;
  longestSessionSeconds: number;
  /** Words dictated today (UTC). */
  todayWords: number;
  dailyWordGoal: number;
  weeklyWordGoal: number;

  thisWeek: DictationPeriodTotals;
  lastWeek: DictationPeriodTotals;

  /** All ten filler words in a fixed order, zeros included. */
  fillerCounts: [string, number][];
  /** Two-word phrases seen at least twice, not entirely stopwords. Sorted by
   *  count descending, then phrase ascending. */
  topBigrams: [string, number][];
  topTrigrams: [string, number][];
  /** Words over three characters outside the common-word list, seen twice or
   *  more. Same ordering as the phrase lists. */
  rareWords: [string, number][];
  wordLengths: DictationWordLengths;
  /** Flesch-Kincaid grade level, clamped to 1-18; 0 when there are no words. */
  readingLevel: number;
  /** Words first used this UTC week, in first-seen order, capped at 50. Use
   *  `newWordsThisWeekCount` for the headline number. */
  newWordsThisWeek: string[];
  newWordsThisWeekCount: number;

  sentimentCoverage: DictationSentimentCoverage;
}

export interface DictationSettings {
  modelSize: string;
  /** Stable host-qualified CPAL identity. Preferred over deviceIndex. */
  deviceId: string | null;
  /** Legacy migration fallback for settings created before v0.10.3. */
  deviceIndex: number | null;
  customDictionary: string[];
  autoPaste: boolean;
  /** Whisper language code, or "auto" for language detection. */
  language: string;
  /** Paste into the foreground OS application when no PacketBench field is active. */
  systemWidePaste: boolean;
  /** OS-global accelerator for push-to-talk (hold). Optional — falls back to
   *  the hardcoded default in `useDictationGlobalShortcuts` when omitted. */
  pushToTalkShortcut?: string;
  /** OS-global accelerator for toggle recording. */
  toggleShortcut?: string;
  /** Explicit opt-in for OS-global shortcut registration. */
  globalShortcutsEnabled: boolean;
  /** Hard upper bound for retained PCM, clamped by the backend to 10–1800s. */
  maxDurationSeconds: number;
  /** Words-per-day target charted in Analytics → Consistency. `0` = no goal,
   *  which drops the bar rather than charting against an always-met target. */
  dailyWordGoal: number;
  /** Words-per-week target. Same `0` = no goal contract. */
  weeklyWordGoal: number;
}

/** Ceiling the backend clamps either goal to (`MAX_WORD_GOAL` in
 *  `src-tauri/src/commands/dictation/config.rs`). Mirrored here so the number
 *  inputs cannot offer a value the backend will silently rewrite. */
export const MAX_WORD_GOAL = 1_000_000;

/** Default accelerator strings — kept in one place so the store, the
 *  capture UI, and the global-shortcut hook agree. Format follows
 *  `@tauri-apps/plugin-global-shortcut` accelerator syntax. */
export const DEFAULT_PUSH_TO_TALK_SHORTCUT = "CommandOrControl+Alt+Space";
export const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Alt+R";
export const DICTATION_OPEN_SHORTCUT = "CommandOrControl+Shift+D";

export interface WhisperModel {
  size: string;
  downloaded: boolean;
  installed: boolean;
  /** Advertised download size from the shipped spec, in MB. */
  fileSizeMb: number;
  /** Bytes the file actually occupies on disk right now, or `null` when
   *  nothing is installed. Deletion quotes this, not `fileSizeMb`. */
  diskBytes: number | null;
  path: string | null;
}

export interface AudioDevice {
  index: number;
  id: string | null;
  name: string;
  isDefault: boolean;
  sampleRate: number | null;
  channels: number | null;
  sampleFormat: string | null;
}

export interface AudioDeviceTestResult {
  deviceId: string | null;
  name: string;
  sampleRate: number;
  channels: number;
  sampleFormat: string;
  capturedFrames: number;
  durationMs: number;
  peakLevel: number;
  rmsLevel: number;
  warning: string | null;
}

export interface DictationResult {
  text: string;
  durationSeconds: number | null;
  inputSampleRate: number;
  channels: number;
  sampleFormat: string;
  deviceName: string;
  deviceId: string | null;
  modelSize: string;
  detectedLanguage: string | null;
  modelLoadMs: number;
  inferenceMs: number;
  warnings: string[];
}

export type DictationShortcutStatus =
  | { state: "disabled"; message: string }
  | { state: "registering"; message: string }
  | { state: "ready"; message: string }
  | { state: "error"; message: string };

export function validateDictationShortcuts(
  pushToTalk: string,
  toggle: string,
  open = DICTATION_OPEN_SHORTCUT,
): string | null {
  const values = [pushToTalk.trim(), toggle.trim(), open.trim()];
  if (values.some((value) => value.length === 0)) {
    return "Shortcut values cannot be empty.";
  }
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    return "Push-to-talk, toggle, and open shortcuts must be different.";
  }
  return null;
}
