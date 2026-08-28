import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DictationAnalytics } from "@/types/dictation";
import { AnalyticsPanel } from "./AnalyticsPanel";

/**
 * Branch coverage for the panel's two judgement calls: what a fresh install
 * sees, and what the sentiment section is allowed to claim. The chart
 * primitives themselves are covered by `charts/charts.test.tsx`.
 */

function fixture(overrides: Partial<DictationAnalytics> = {}): DictationAnalytics {
  return {
    totalEntries: 3,
    totalWords: 1_200,
    averageWpm: 118,
    fastestWpm: 165,
    averageSentiment: 0,
    totalDurationMinutes: 10,
    longestEntryWords: 400,
    hourlyActivity: new Array<number>(24).fill(0).map((_v, hour) => (hour === 9 ? 3 : 0)),
    topWords: [
      ["project", 12],
      ["release", 7],
    ],
    modeBreakdown: { transcribe: 3 },
    vocabularyDiversity: 0.42,
    dailyStreak: 2,
    timeSavedMinutes: 20,
    activityMatrix: Array.from({ length: 7 }, (_row, day) =>
      new Array<number>(24).fill(0).map((_v, hour) => (day === 1 && hour === 9 ? 3 : 0)),
    ),
    wpmByHour: new Array<number | null>(24).fill(null).map((_v, hour) => (hour === 9 ? 118 : null)),
    dailySeries: [
      {
        date: "2026-08-26",
        entries: 1,
        words: 400,
        durationSeconds: 200,
        avgWpm: 120,
        vocabSize: 180,
        avgSentiment: null,
      },
      {
        date: "2026-08-27",
        entries: 2,
        words: 800,
        durationSeconds: 400,
        avgWpm: 116,
        vocabSize: 260,
        avgSentiment: null,
      },
    ],
    dailySeriesCarry: { days: 0, words: 0, durationSeconds: 0, timeSavedMinutes: 0 },
    currentStreak: 2,
    longestStreak: 9,
    maxWordsInDay: 800,
    longestSessionSeconds: 420,
    todayWords: 800,
    dailyWordGoal: 1_000,
    weeklyWordGoal: 5_000,
    thisWeek: { words: 1_200, sessions: 3, durationSeconds: 600 },
    lastWeek: { words: 400, sessions: 1, durationSeconds: 200 },
    fillerCounts: [
      ["um", 4],
      ["like", 0],
    ],
    topBigrams: [["the release", 3]],
    topTrigrams: [],
    rareWords: [["orchestrator", 2]],
    wordLengths: { short: 300, medium: 600, long: 300 },
    readingLevel: 9.4,
    newWordsThisWeek: ["orchestrator", "sidecar"],
    newWordsThisWeekCount: 2,
    sentimentCoverage: { scoredEntries: 0, totalEntries: 3, scoredDays: 0 },
    ...overrides,
  };
}

describe("AnalyticsPanel — empty install", () => {
  it("shows one informative panel rather than a wall of empty frames", () => {
    render(
      <AnalyticsPanel
        analytics={fixture({
          totalEntries: 0,
          totalWords: 0,
          dailySeries: [],
          topWords: [],
          fillerCounts: [],
          topBigrams: [],
          rareWords: [],
          newWordsThisWeek: [],
          newWordsThisWeekCount: 0,
          readingLevel: 0,
        })}
      />,
    );

    expect(screen.getByText(/No transcriptions yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Words per day/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Personal records/i })).not.toBeInTheDocument();
  });
});

describe("AnalyticsPanel — sentiment coverage", () => {
  it("never presents an unscored corpus as neutral", () => {
    render(<AnalyticsPanel analytics={fixture()} />);

    const frame = screen.getByRole("group", { name: /Sentiment over time/i });
    expect(frame).toHaveTextContent(/sentiment score yet/i);
    expect(screen.queryByText("Neutral")).not.toBeInTheDocument();
    expect(screen.queryByText(/Average sentiment/i)).not.toBeInTheDocument();
  });

  it("labels partial coverage on the chart and the headline tile", () => {
    render(
      <AnalyticsPanel
        analytics={fixture({
          totalEntries: 840,
          averageSentiment: 0.36,
          sentimentCoverage: { scoredEntries: 12, totalEntries: 840, scoredDays: 2 },
          dailySeries: [
            {
              date: "2026-08-26",
              entries: 1,
              words: 400,
              durationSeconds: 200,
              avgWpm: 120,
              vocabSize: 180,
              avgSentiment: 0.4,
            },
            {
              date: "2026-08-27",
              entries: 2,
              words: 800,
              durationSeconds: 400,
              avgWpm: 116,
              vocabSize: 260,
              avgSentiment: -0.1,
            },
          ],
        })}
      />,
    );

    expect(screen.getAllByText(/scored 12 of 840 entries/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not counted as neutral/i)).toBeInTheDocument();
    expect(screen.getByText(/Average sentiment/i)).toBeInTheDocument();
  });
});

describe("AnalyticsPanel — streaks", () => {
  it("keeps the current streak and the last run distinct", () => {
    render(
      <AnalyticsPanel analytics={fixture({ currentStreak: 0, dailyStreak: 5, longestStreak: 9 })} />,
    );

    const frame = screen.getByRole("group", { name: /Streaks/i });
    expect(frame).toHaveTextContent("Current");
    expect(frame).toHaveTextContent("Last run");
    expect(frame).toHaveTextContent(/did not include today or yesterday/i);
  });
});

describe("AnalyticsPanel — composition", () => {
  it("renders the charts that replaced the hand-rolled strips", () => {
    render(<AnalyticsPanel analytics={fixture()} />);

    for (const name of [
      /Words per day/i,
      /Words per minute/i,
      /Vocabulary growth/i,
      /Cumulative talking time/i,
      /Cumulative time saved/i,
      /Daily activity/i,
      /Week by hour/i,
      /Peak hours/i,
      /Speed by hour/i,
      /Top words/i,
      /Filler words/i,
      /Distinctive words/i,
      /Word length/i,
      /Common two-word phrases/i,
      /New words this week/i,
      /Reading level/i,
      /Personal records/i,
      /This week vs last/i,
    ]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
  });

  it("keeps the SVG decorative and the data table reachable", () => {
    render(<AnalyticsPanel analytics={fixture()} />);

    const frame = screen.getByRole("group", { name: /Words per day/i });
    expect(frame.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(frame.querySelector("details summary")).not.toBeNull();
  });
});
