import { describe, expect, it } from "vitest";
import type {
  DictationAnalytics,
  DictationDailyCarry,
  DictationDailyPoint,
} from "@/types/dictation";
import {
  buildYearlyHeatmap,
  carryNote,
  cumulativeTalkingSeries,
  cumulativeTimeSavedSeries,
  dayTimeSavedMinutes,
  fillerBars,
  formatMinutes,
  periodComparisonBars,
  periodComparisonMax,
  readingLevelLabel,
  sentimentDisplay,
  toChartDate,
  toUtcDayKey,
  utcDayStartMs,
  wordLengthBars,
  wpmHourBars,
  wpmSeries,
} from "./analytics-derive";

/**
 * The chart primitives are covered by `charts/charts.test.tsx`. What is under
 * test here is the panel's own arithmetic and its three payload-semantics
 * decisions, each of which fails silently rather than loudly when it is wrong:
 *
 * - a cumulative series that forgets `dailySeriesCarry` under-reports the
 *   entire history that predates the 365-day window;
 * - a null `avgSentiment` plotted as 0 turns "not scored" into "neutral";
 * - a local-time re-bucket disagrees with the UTC streak and goal numbers.
 */

function day(overrides: Partial<DictationDailyPoint> & { date: string }): DictationDailyPoint {
  return {
    entries: 1,
    words: 0,
    durationSeconds: 0,
    avgWpm: null,
    vocabSize: 0,
    avgSentiment: null,
    ...overrides,
  };
}

const NO_CARRY: DictationDailyCarry = {
  days: 0,
  words: 0,
  durationSeconds: 0,
  timeSavedMinutes: 0,
};

function analyticsFixture(overrides: Partial<DictationAnalytics> = {}): DictationAnalytics {
  return {
    totalEntries: 0,
    totalWords: 0,
    averageWpm: 0,
    fastestWpm: 0,
    averageSentiment: 0,
    totalDurationMinutes: 0,
    longestEntryWords: 0,
    hourlyActivity: new Array<number>(24).fill(0),
    topWords: [],
    modeBreakdown: {},
    vocabularyDiversity: 0,
    dailyStreak: 0,
    timeSavedMinutes: 0,
    activityMatrix: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
    wpmByHour: new Array<number | null>(24).fill(null),
    dailySeries: [],
    dailySeriesCarry: NO_CARRY,
    currentStreak: 0,
    longestStreak: 0,
    maxWordsInDay: 0,
    longestSessionSeconds: 0,
    todayWords: 0,
    dailyWordGoal: 500,
    weeklyWordGoal: 2500,
    thisWeek: { words: 0, sessions: 0, durationSeconds: 0 },
    lastWeek: { words: 0, sessions: 0, durationSeconds: 0 },
    fillerCounts: [],
    topBigrams: [],
    topTrigrams: [],
    rareWords: [],
    wordLengths: { short: 0, medium: 0, long: 0 },
    readingLevel: 0,
    newWordsThisWeek: [],
    newWordsThisWeekCount: 0,
    sentimentCoverage: { scoredEntries: 0, totalEntries: 0, scoredDays: 0 },
    ...overrides,
  };
}

describe("per-day time saved", () => {
  it("is words at 40 wpm minus the spoken minutes", () => {
    // 400 words would take 10 minutes to type; it was spoken in 4.
    expect(dayTimeSavedMinutes(day({ date: "2026-08-01", words: 400, durationSeconds: 240 }))).toBe(
      6,
    );
  });

  it("clamps at zero rather than going negative on a slow day", () => {
    expect(dayTimeSavedMinutes(day({ date: "2026-08-01", words: 40, durationSeconds: 600 }))).toBe(
      0,
    );
  });
});

describe("cumulative series seeded from the carry", () => {
  const series = [
    day({ date: "2026-08-01", words: 400, durationSeconds: 240 }),
    day({ date: "2026-08-02", words: 800, durationSeconds: 300 }),
  ];

  it("starts talking time from the carried duration, not from zero", () => {
    const carry: DictationDailyCarry = {
      days: 120,
      words: 50_000,
      durationSeconds: 3_600,
      timeSavedMinutes: 900,
    };
    const points = cumulativeTalkingSeries(series, carry);
    // 60 carried minutes + 4, then + 5.
    expect(points.map((point) => point.value)).toEqual([64, 69]);
  });

  it("starts time saved from the carried minutes, not from zero", () => {
    const carry: DictationDailyCarry = {
      days: 120,
      words: 50_000,
      durationSeconds: 3_600,
      timeSavedMinutes: 900,
    };
    const points = cumulativeTimeSavedSeries(series, carry);
    // 900 + max(0, 10 - 4) = 906, then + max(0, 20 - 5) = 921.
    expect(points.map((point) => point.value)).toEqual([906, 921]);
  });

  it("sums the per-day clamped values, so a slow day never subtracts", () => {
    const withSlowDay = [
      day({ date: "2026-08-01", words: 400, durationSeconds: 240 }),
      day({ date: "2026-08-02", words: 40, durationSeconds: 1_200 }),
      day({ date: "2026-08-03", words: 400, durationSeconds: 240 }),
    ];
    const points = cumulativeTimeSavedSeries(withSlowDay, NO_CARRY);
    expect(points.map((point) => point.value)).toEqual([6, 6, 12]);
  });

  it("is monotonically non-decreasing", () => {
    const points = cumulativeTalkingSeries(series, NO_CARRY);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].value).toBeGreaterThanOrEqual(points[i - 1].value);
    }
  });

  it("still produces the carried base when the window is empty", () => {
    const carry: DictationDailyCarry = {
      days: 30,
      words: 1_000,
      durationSeconds: 600,
      timeSavedMinutes: 15,
    };
    expect(cumulativeTimeSavedSeries([], carry)).toEqual([]);
    expect(carryNote(carry)).toBe("includes 30 earlier days");
    expect(carryNote(NO_CARRY)).toBeNull();
  });
});

describe("UTC bucketing", () => {
  it("anchors chart dates at UTC noon so the label never slips a day", () => {
    const midnight = utcDayStartMs("2026-08-27");
    expect(toChartDate("2026-08-27") - midnight).toBe(43_200_000);
    expect(toUtcDayKey(toChartDate("2026-08-27"))).toBe("2026-08-27");
  });

  it("keys the yearly grid by UTC day", () => {
    expect(toUtcDayKey(utcDayStartMs("2026-01-01"))).toBe("2026-01-01");
  });
});

describe("sentiment gating", () => {
  it("reports no data when nothing is scored, never 'neutral'", () => {
    const display = sentimentDisplay(
      analyticsFixture({
        totalEntries: 840,
        averageSentiment: 0,
        sentimentCoverage: { scoredEntries: 0, totalEntries: 840, scoredDays: 0 },
        dailySeries: [day({ date: "2026-08-01", words: 10 })],
      }),
    );
    expect(display.kind).toBe("unscored");
    expect(display.kind === "unscored" && display.message).toContain("840");
  });

  it("labels partial coverage honestly", () => {
    const display = sentimentDisplay(
      analyticsFixture({
        totalEntries: 840,
        averageSentiment: 0.42,
        sentimentCoverage: { scoredEntries: 12, totalEntries: 840, scoredDays: 3 },
        dailySeries: [
          day({ date: "2026-08-01", avgSentiment: 0.5 }),
          day({ date: "2026-08-02", avgSentiment: null }),
          day({ date: "2026-08-03", avgSentiment: -0.25 }),
        ],
      }),
    );
    expect(display.kind).toBe("scored");
    if (display.kind !== "scored") return;
    expect(display.coverageLabel).toBe("scored 12 of 840 entries across 3 days");
    // The unscored middle day is dropped, not plotted as zero.
    expect(display.points).toHaveLength(2);
    expect(display.points.map((point) => point.value)).toEqual([0.5, -0.25]);
  });

  it("distinguishes 'scored but outside the window' from 'never scored'", () => {
    const display = sentimentDisplay(
      analyticsFixture({
        totalEntries: 900,
        sentimentCoverage: { scoredEntries: 5, totalEntries: 900, scoredDays: 2 },
        dailySeries: [day({ date: "2026-08-01", avgSentiment: null })],
      }),
    );
    expect(display.kind).toBe("outside-window");
  });

  it("treats an empty corpus as unscored without claiming a mean", () => {
    expect(sentimentDisplay(analyticsFixture()).kind).toBe("unscored");
  });
});

describe("yearly heatmap pivot", () => {
  it("lays out seven weekday rows starting on Sunday", () => {
    // 2026-08-02 is a Sunday; 2026-08-27 is a Thursday.
    const grid = buildYearlyHeatmap([
      day({ date: "2026-08-02", entries: 3 }),
      day({ date: "2026-08-27", entries: 1 }),
    ]);
    expect(grid.rows).toHaveLength(7);
    expect(grid.cellDates[0][0]).toBe("2026-08-02");
    expect(grid.rows[0][0]).toBe(3);
    // Thursday of the fourth week.
    expect(grid.rows[4][3]).toBe(1);
    expect(grid.weeks).toBe(4);
  });

  it("fills quiet days with zero rather than leaving holes", () => {
    const grid = buildYearlyHeatmap([
      day({ date: "2026-08-02", entries: 2 }),
      day({ date: "2026-08-05", entries: 4 }),
    ]);
    expect(grid.rows[1][0]).toBe(0);
    expect(grid.rows[3][0]).toBe(4);
  });

  it("marks cells outside the data range as having no date", () => {
    const grid = buildYearlyHeatmap([day({ date: "2026-08-04", entries: 1 })]);
    // Sunday and Monday precede the only day in range.
    expect(grid.cellDates[0][0]).toBeNull();
    expect(grid.cellDates[2][0]).toBe("2026-08-04");
  });

  it("never exceeds 53 columns even for a full window", () => {
    const series = Array.from({ length: 365 }, (_unused, index) =>
      day({ date: toUtcDayKey(utcDayStartMs("2025-08-27") + index * 86_400_000), entries: 1 }),
    );
    const grid = buildYearlyHeatmap(series);
    expect(grid.weeks).toBeLessThanOrEqual(53);
    expect(grid.columnLabels).toHaveLength(grid.weeks);
    expect(grid.columnLabels.filter(Boolean).length).toBeGreaterThanOrEqual(12);
  });

  it("returns an empty grid for an empty series instead of throwing", () => {
    const grid = buildYearlyHeatmap([]);
    expect(grid.rows).toEqual([]);
    expect(grid.weeks).toBe(0);
  });
});

describe("bar shaping", () => {
  it("keeps a null hour null so it renders as 'no reading', not zero wpm", () => {
    const bars = wpmHourBars([90, null, ...new Array<number | null>(22).fill(null)]);
    expect(bars).toHaveLength(24);
    expect(bars[0].value).toBe(90);
    expect(bars[1].value).toBeNull();
    expect(bars[0].label).toBe("00:00 UTC");
  });

  it("drops the zero-count filler words the payload always includes", () => {
    const bars = fillerBars([
      ["um", 0],
      ["like", 7],
      ["you know", 3],
      ["basically", 0],
    ]);
    expect(bars.map((bar) => bar.label)).toEqual(["like", "you know"]);
  });

  it("shares a ceiling between this week and last", () => {
    const thisWeek = { words: 1_200, sessions: 9, durationSeconds: 1_800 };
    const lastWeek = { words: 3_000, sessions: 21, durationSeconds: 5_400 };
    expect(periodComparisonMax(thisWeek, lastWeek)).toBe(3_000);
    const bars = periodComparisonBars(thisWeek, lastWeek);
    expect(bars.map((bar) => bar.value)).toEqual([1_200, 3_000]);
    expect(bars[0].note).toBe("9 sessions / 30m");
  });

  it("falls back to a ceiling of one when both weeks are empty", () => {
    const empty = { words: 0, sessions: 0, durationSeconds: 0 };
    expect(periodComparisonMax(empty, empty)).toBe(1);
  });

  it("buckets word lengths into the payload's three bands", () => {
    const bars = wordLengthBars({ short: 10, medium: 20, long: 5 });
    expect(bars.map((bar) => [bar.label, bar.value])).toEqual([
      ["1-3 chars", 10],
      ["4-6 chars", 20],
      ["7+ chars", 5],
    ]);
  });

  it("drops days with no recorded speed from the wpm series", () => {
    const points = wpmSeries([
      day({ date: "2026-08-01", avgWpm: 120 }),
      day({ date: "2026-08-02", avgWpm: null }),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(120);
  });
});

describe("formatting", () => {
  it("formats minute totals compactly", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(0.5)).toBe("30s");
    expect(formatMinutes(42)).toBe("42m");
    expect(formatMinutes(125)).toBe("2h 5m");
  });

  it("treats reading level zero as 'no text', not grade zero", () => {
    expect(readingLevelLabel(0)).toBe("Not enough text yet");
    expect(readingLevelLabel(8)).toContain("Conversational");
  });
});
