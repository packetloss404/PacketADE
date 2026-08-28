/**
 * Client-side derivations for the dictation analytics panel.
 *
 * Everything here is pure: `DictationAnalytics` in, chart-ready values out. It
 * lives in its own `.ts` module (rather than beside the JSX) for two reasons —
 * these are the only parts of the panel with real logic worth unit-testing, and
 * keeping non-component exports out of the `.tsx` files keeps
 * `react-refresh/only-export-components` quiet.
 *
 * Three payload semantics are load-bearing and are enforced here rather than
 * being left to each call site:
 *
 * 1. **Cumulative series start from the carry.** `dailySeries` is bounded to
 *    the newest 365 day-buckets; `dailySeriesCarry` holds the totals for
 *    everything older. A running sum that starts at zero silently under-reports
 *    the entire history before the window.
 * 2. **`avgSentiment: null` means "no scored entry", not "neutral".** Null days
 *    are dropped from the series, never coerced to 0, and the whole section is
 *    gated on `sentimentCoverage`.
 * 3. **Every calendar bucket is UTC**, because the Rust side has no tz
 *    database. Re-bucketing in local time here would disagree with the streak,
 *    goal, and "this week" numbers computed server-side.
 *
 * See `dev/dictation-analytics-charting.md` and the doc comments on
 * `src/types/dictation.ts`.
 */

import type {
  DictationAnalytics,
  DictationDailyCarry,
  DictationDailyPoint,
  DictationPeriodTotals,
  DictationWordLengths,
} from "@/types/dictation";
import type { BarDatum, TimeSeriesPoint } from "./charts";

const DAY_MS = 86_400_000;

/**
 * Typing words-per-minute the backend assumes when it computes time saved.
 * Mirrors `Math.max(0, words / 40 - durationSeconds / 60)` documented on
 * {@link DictationDailyPoint}; the per-day clamp at zero happens *before*
 * summing, which is why {@link DictationDailyCarry.timeSavedMinutes} cannot be
 * recovered from the carry's word and duration totals.
 */
export const TYPING_WPM_BASELINE = 40;

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Epoch ms for UTC midnight of a `YYYY-MM-DD` bucket key. */
export function utcDayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Epoch ms for UTC *noon* of a day-bucket — the value handed to the charts as
 * `TimeSeriesPoint.date`.
 *
 * The buckets are UTC but `TimeSeriesChart` labels its axis with a local-time
 * `Intl.DateTimeFormat`. Anchoring at midnight would render the UTC day as the
 * previous calendar day for every viewer west of Greenwich. Noon keeps the
 * label on the correct UTC day for every offset inside +/-12h without
 * re-bucketing anything.
 */
export function toChartDate(date: string): number {
  const midnight = utcDayStartMs(date);
  return Number.isNaN(midnight) ? Number.NaN : midnight + DAY_MS / 2;
}

/** `YYYY-MM-DD` for an epoch ms instant, in UTC. */
export function toUtcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Minutes of typing saved on one day. Clamped at zero, exactly as the backend
 *  does before folding old days into the carry. */
export function dayTimeSavedMinutes(point: DictationDailyPoint): number {
  const typed = point.words / TYPING_WPM_BASELINE;
  const spoken = point.durationSeconds / 60;
  return Math.max(0, typed - spoken);
}

/* ── Time series ── */

export function wordsPerDaySeries(
  series: readonly DictationDailyPoint[],
): TimeSeriesPoint[] {
  return series.map((point) => ({ date: toChartDate(point.date), value: point.words }));
}

export function vocabularyGrowthSeries(
  series: readonly DictationDailyPoint[],
): TimeSeriesPoint[] {
  return series.map((point) => ({ date: toChartDate(point.date), value: point.vocabSize }));
}

/** Days that recorded a WPM. Days without one are dropped, not zeroed — a zero
 *  would drag the `extent` baseline down and read as "very slow that day". */
export function wpmSeries(series: readonly DictationDailyPoint[]): TimeSeriesPoint[] {
  const out: TimeSeriesPoint[] = [];
  for (const point of series) {
    if (point.avgWpm === null || !Number.isFinite(point.avgWpm)) continue;
    out.push({ date: toChartDate(point.date), value: point.avgWpm });
  }
  return out;
}

/**
 * Running total of time saved, seeded from the carry so the line continues the
 * history instead of restarting at zero when the 365-day window truncates.
 */
export function cumulativeTimeSavedSeries(
  series: readonly DictationDailyPoint[],
  carry: DictationDailyCarry,
): TimeSeriesPoint[] {
  let running = Number.isFinite(carry.timeSavedMinutes) ? carry.timeSavedMinutes : 0;
  return series.map((point) => {
    running += dayTimeSavedMinutes(point);
    return { date: toChartDate(point.date), value: running };
  });
}

/** Running total of spoken minutes, seeded from the carry. */
export function cumulativeTalkingSeries(
  series: readonly DictationDailyPoint[],
  carry: DictationDailyCarry,
): TimeSeriesPoint[] {
  const seed = Number.isFinite(carry.durationSeconds) ? carry.durationSeconds / 60 : 0;
  let running = seed;
  return series.map((point) => {
    running += point.durationSeconds / 60;
    return { date: toChartDate(point.date), value: running };
  });
}

/** Human note for a carry seed, or null when `dailySeries` is complete. */
export function carryNote(carry: DictationDailyCarry): string | null {
  if (!carry || carry.days <= 0) return null;
  return `includes ${carry.days.toLocaleString()} earlier day${carry.days === 1 ? "" : "s"}`;
}

/* ── Sentiment gating ── */

export type SentimentDisplay =
  | {
      /** Nothing in the corpus has been scored. `averageSentiment` is 0 because
       *  there is no data — it must not be shown as "Neutral". */
      kind: "unscored";
      message: string;
    }
  | {
      /** Scores exist, but none of them fall inside the charted window. */
      kind: "outside-window";
      message: string;
      coverageLabel: string;
    }
  | {
      kind: "scored";
      points: TimeSeriesPoint[];
      coverageLabel: string;
      average: number;
    };

/**
 * Decide what the sentiment section may claim.
 *
 * The VADER scorer landed recently, so almost every historical row is NULL and
 * "unscored" is the common case rather than the edge case. `averageSentiment`
 * is a mean over scored rows only and is 0 when nothing is scored, which is
 * indistinguishable from a genuinely neutral corpus unless the coverage counts
 * are consulted first.
 */
export function sentimentDisplay(analytics: DictationAnalytics): SentimentDisplay {
  const coverage = analytics.sentimentCoverage;
  const scoredEntries = coverage?.scoredEntries ?? 0;
  const totalEntries = coverage?.totalEntries ?? analytics.totalEntries;
  const scoredDays = coverage?.scoredDays ?? 0;

  if (scoredEntries <= 0 || scoredDays <= 0) {
    return {
      kind: "unscored",
      message:
        totalEntries > 0
          ? `None of your ${totalEntries.toLocaleString()} transcriptions carry a sentiment score yet. Scoring was added recently and only applies to new recordings, so this stays empty until you record again.`
          : "Sentiment appears once you have recorded something.",
    };
  }

  const coverageLabel = `scored ${scoredEntries.toLocaleString()} of ${totalEntries.toLocaleString()} entries across ${scoredDays.toLocaleString()} day${scoredDays === 1 ? "" : "s"}`;

  const points: TimeSeriesPoint[] = [];
  for (const point of analytics.dailySeries) {
    if (point.avgSentiment === null || !Number.isFinite(point.avgSentiment)) continue;
    points.push({ date: toChartDate(point.date), value: point.avgSentiment });
  }

  if (points.length === 0) {
    return {
      kind: "outside-window",
      message:
        "Every scored entry predates the charted window, so there is nothing to plot here.",
      coverageLabel,
    };
  }

  return { kind: "scored", points, coverageLabel, average: analytics.averageSentiment };
}

/* ── Heatmaps ── */

export interface YearlyHeatmap {
  /** 7 weekday rows (Sunday first) x N week columns; zero where there is no
   *  entry, and also zero for cells outside the data range. */
  rows: number[][];
  /** `YYYY-MM-DD` for each cell, or null when the cell is outside the range. */
  cellDates: (string | null)[][];
  /** Month abbreviation on the first week of each month, null elsewhere. */
  columnLabels: (string | null)[];
  weeks: number;
}

const EMPTY_YEARLY: YearlyHeatmap = {
  rows: [],
  cellDates: [],
  columnLabels: [],
  weeks: 0,
};

/**
 * Pivot `dailySeries` into the GitHub-style contribution grid: weekday rows,
 * week columns, Sunday-start, all in UTC.
 *
 * Only days with at least one entry appear in `dailySeries`, so quiet days are
 * absent rather than zero — the grid fills them in explicitly.
 */
export function buildYearlyHeatmap(series: readonly DictationDailyPoint[]): YearlyHeatmap {
  if (series.length === 0) return EMPTY_YEARLY;

  const counts = new Map<string, number>();
  for (const point of series) counts.set(point.date, point.entries);

  const lastMs = utcDayStartMs(series[series.length - 1].date);
  const firstMs = utcDayStartMs(series[0].date);
  if (Number.isNaN(lastMs) || Number.isNaN(firstMs)) return EMPTY_YEARLY;

  // Never more than 53 columns, even if the window somehow reaches further.
  const windowStart = Math.max(firstMs, lastMs - 364 * DAY_MS);
  const startMs = windowStart - new Date(windowStart).getUTCDay() * DAY_MS;
  const weeks = Math.floor((lastMs - startMs) / (7 * DAY_MS)) + 1;

  const rows: number[][] = Array.from({ length: 7 }, () => new Array<number>(weeks).fill(0));
  const cellDates: (string | null)[][] = Array.from({ length: 7 }, () =>
    new Array<string | null>(weeks).fill(null),
  );

  for (let week = 0; week < weeks; week += 1) {
    for (let day = 0; day < 7; day += 1) {
      const ms = startMs + (week * 7 + day) * DAY_MS;
      if (ms < windowStart || ms > lastMs) continue;
      const key = toUtcDayKey(ms);
      cellDates[day][week] = key;
      rows[day][week] = counts.get(key) ?? 0;
    }
  }

  const columnLabels: (string | null)[] = new Array<string | null>(weeks).fill(null);
  let previousMonth = -1;
  for (let week = 0; week < weeks; week += 1) {
    const month = new Date(startMs + week * 7 * DAY_MS).getUTCMonth();
    if (month !== previousMonth) {
      columnLabels[week] = MONTH_LABELS[month];
      previousMonth = month;
    }
  }

  return { rows, cellDates, columnLabels, weeks };
}

/** Sparse hour labels for the 24-column activity heatmap and the hour bars. */
export function hourAxisLabels(): (string | null)[] {
  return Array.from({ length: 24 }, (_unused, hour) =>
    hour % 6 === 0 ? `${String(hour).padStart(2, "0")}` : null,
  );
}

/* ── Bars ── */

export function hourBars(counts: readonly number[]): BarDatum[] {
  return Array.from({ length: 24 }, (_unused, hour) => ({
    label: `${String(hour).padStart(2, "0")}:00 UTC`,
    value: counts[hour] ?? 0,
  }));
}

/** WPM per UTC hour. `null` stays null so the primitive renders a "no reading"
 *  tick rather than a zero-height bar that reads as "very slow at 3am". */
export function wpmHourBars(wpmByHour: readonly (number | null)[]): BarDatum[] {
  return Array.from({ length: 24 }, (_unused, hour) => {
    const raw = wpmByHour[hour];
    return {
      label: `${String(hour).padStart(2, "0")}:00 UTC`,
      value: raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw,
    };
  });
}

export function pairBars(pairs: readonly [string, number][], limit = 10): BarDatum[] {
  return pairs.slice(0, limit).map(([label, value]) => ({ label, value }));
}

/** Filler words arrive in a fixed order with zeros included; a list of ten
 *  zero bars is noise, so drop them and rank what actually occurred. */
export function fillerBars(pairs: readonly [string, number][], limit = 10): BarDatum[] {
  return pairs
    .filter(([, value]) => value > 0)
    .slice()
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

export function wordLengthBars(lengths: DictationWordLengths): BarDatum[] {
  return [
    { label: "1-3 chars", value: lengths.short },
    { label: "4-6 chars", value: lengths.medium, tone: "blue" as const },
    { label: "7+ chars", value: lengths.long, tone: "purple" as const },
  ];
}

/** This week versus last week, sharing a ceiling so the two rows are
 *  comparable rather than each normalised to itself. */
export function periodComparisonBars(
  thisWeek: DictationPeriodTotals,
  lastWeek: DictationPeriodTotals,
): BarDatum[] {
  const describe = (totals: DictationPeriodTotals) =>
    `${totals.sessions} session${totals.sessions === 1 ? "" : "s"} / ${formatMinutes(totals.durationSeconds / 60)}`;
  return [
    { label: "This week", value: thisWeek.words, note: describe(thisWeek) },
    { label: "Last week", value: lastWeek.words, tone: "blue" as const, note: describe(lastWeek) },
  ];
}

export function periodComparisonMax(
  thisWeek: DictationPeriodTotals,
  lastWeek: DictationPeriodTotals,
): number {
  return Math.max(thisWeek.words, lastWeek.words, 1);
}

/* ── Formatting ── */

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return `${hours}h ${rest}m`;
}

export function formatSeconds(seconds: number): string {
  return formatMinutes(seconds / 60);
}

/** Flesch-Kincaid grade band. 0 means "no words", not "grade zero". */
export function readingLevelLabel(level: number): string {
  if (!Number.isFinite(level) || level <= 0) return "Not enough text yet";
  if (level <= 6) return "Plain — around primary school";
  if (level <= 9) return "Conversational — middle school";
  if (level <= 12) return "Standard — high school";
  if (level <= 15) return "Involved — undergraduate";
  return "Dense — postgraduate";
}

/** A signed sentiment mean, only ever called once coverage has been checked. */
export function formatSentiment(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

export function sentimentToneClass(value: number): string {
  if (value >= 0.1) return "text-accent-green";
  if (value <= -0.1) return "text-accent-red";
  return "text-text-muted";
}
