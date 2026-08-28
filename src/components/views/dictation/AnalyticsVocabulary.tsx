/**
 * What you say: ranked word and phrase lists, the word-length distribution, the
 * new-vocabulary chips, and the reading level.
 *
 * The ranked lists are all `BarSeries` in `horizontal` orientation — they are
 * `value / max` proportions, not charts, so they need no scale object. The last
 * two panels are a list and a number and use `ChartFrame` directly for the free
 * accessible naming.
 */

import { BarSeries, ChartFrame } from "./charts";
import {
  fillerBars,
  pairBars,
  readingLevelLabel,
  wordLengthBars,
} from "./analytics-derive";
import type { DictationAnalytics } from "@/types/dictation";

export function AnalyticsVocabulary({ analytics }: { analytics: DictationAnalytics }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <BarSeries
          title="Top words"
          data={pairBars(analytics.topWords)}
          orientation="horizontal"
          tone="purple"
          unit="uses"
          emptyLabel="No words recorded yet."
        />

        <BarSeries
          title="Filler words"
          data={fillerBars(analytics.fillerCounts)}
          orientation="horizontal"
          tone="amber"
          unit="uses"
          emptyLabel="No filler words detected — nothing from the tracked list has appeared yet."
        />

        <BarSeries
          title="Distinctive words"
          data={pairBars(analytics.rareWords)}
          orientation="horizontal"
          tone="green"
          unit="uses"
          emptyLabel="No word outside the common list has been used twice yet."
        />

        <BarSeries
          title="Word length"
          data={wordLengthBars(analytics.wordLengths)}
          orientation="horizontal"
          tone="green"
          unit="words"
          emptyLabel="No words recorded yet."
        />

        <BarSeries
          title="Common two-word phrases"
          data={pairBars(analytics.topBigrams)}
          orientation="horizontal"
          tone="blue"
          unit="uses"
          emptyLabel="No two-word phrase has been repeated yet."
        />

        <BarSeries
          title="Common three-word phrases"
          data={pairBars(analytics.topTrigrams)}
          orientation="horizontal"
          tone="blue"
          unit="uses"
          emptyLabel="No three-word phrase has been repeated yet."
        />

        <NewWordsPanel analytics={analytics} />
        <ReadingLevelPanel analytics={analytics} />
      </div>
    </div>
  );
}

/** `newWordsThisWeek` is capped at 50 entries; `newWordsThisWeekCount` is the
 *  real total, so the headline uses the count and the chips are labelled as a
 *  sample when they have been truncated. */
function NewWordsPanel({ analytics }: { analytics: DictationAnalytics }) {
  const words = analytics.newWordsThisWeek;
  const count = analytics.newWordsThisWeekCount;
  const truncated = count > words.length;

  return (
    <ChartFrame
      title="New words this week"
      summary={
        count > 0
          ? `New words this week: ${count} first used in the current UTC week.`
          : "New words this week: nothing new so far."
      }
      caption={count > 0 ? `${count.toLocaleString()} total` : undefined}
      isEmpty={count === 0}
      emptyLabel="No new vocabulary yet this week (UTC, Sunday-start)."
    >
      <div className="flex flex-wrap gap-1">
        {words.map((word) => (
          <span
            key={word}
            className="rounded border border-bg-border bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
          >
            {word}
          </span>
        ))}
      </div>
      {truncated ? (
        <p className="mt-2 text-[10px] text-text-faint">
          {`Showing the first ${words.length} of ${count.toLocaleString()}.`}
        </p>
      ) : null}
    </ChartFrame>
  );
}

/** Flesch-Kincaid grade, clamped 1-18 by the backend, with 0 reserved for "no
 *  words" — which is an empty state, not grade zero. */
function ReadingLevelPanel({ analytics }: { analytics: DictationAnalytics }) {
  const level = analytics.readingLevel;
  const hasLevel = Number.isFinite(level) && level > 0;

  return (
    <ChartFrame
      title="Reading level"
      summary={
        hasLevel
          ? `Reading level: Flesch-Kincaid grade ${level.toFixed(1)} — ${readingLevelLabel(level)}.`
          : "Reading level: not enough text to score yet."
      }
      caption={hasLevel ? "Flesch-Kincaid" : undefined}
      isEmpty={!hasLevel}
      emptyLabel="Not enough text to score a reading level yet."
    >
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-semibold text-accent-green">{level.toFixed(1)}</span>
        <span className="text-[11px] text-text-secondary">{readingLevelLabel(level)}</span>
      </div>
      <p className="mt-1 text-[10px] text-text-faint">
        Grade level of the words you dictate, on a 1-18 scale.
      </p>
    </ChartFrame>
  );
}
