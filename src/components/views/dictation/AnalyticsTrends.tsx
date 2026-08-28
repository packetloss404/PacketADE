/**
 * The six dictation visualisations that need real scale and shape maths, plus
 * the coverage-gated sentiment section.
 *
 * Every one of them is a `TimeSeriesChart` call over a derivation from
 * `analytics-derive.ts`; see `dev/dictation-analytics-charting.md` for the
 * primitive-to-visualisation mapping this file implements.
 */

import { ChartFrame, TimeSeriesChart } from "./charts";
import {
  carryNote,
  cumulativeTalkingSeries,
  cumulativeTimeSavedSeries,
  formatMinutes,
  formatSentiment,
  sentimentDisplay,
  vocabularyGrowthSeries,
  wordsPerDaySeries,
  wpmSeries,
} from "./analytics-derive";
import type { DictationAnalytics } from "@/types/dictation";

export function AnalyticsTrends({ analytics }: { analytics: DictationAnalytics }) {
  const { dailySeries, dailySeriesCarry } = analytics;
  const carry = carryNote(dailySeriesCarry);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <TimeSeriesChart
          title="Words per day"
          data={wordsPerDaySeries(dailySeries)}
          variant="area"
          tone="green"
          unit="words"
          emptyLabel="No day has recorded words yet."
        />

        <TimeSeriesChart
          title="Words per minute"
          data={wpmSeries(dailySeries)}
          variant="line"
          tone="blue"
          yBaseline="extent"
          unit="wpm"
          emptyLabel="No entry has recorded a speaking rate yet."
        />

        <TimeSeriesChart
          title="Vocabulary growth"
          data={vocabularyGrowthSeries(dailySeries)}
          variant="area"
          tone="amber"
          unit="words"
          emptyLabel="Distinct words appear once you have recorded something."
        />

        <TimeSeriesChart
          title="Cumulative talking time"
          data={cumulativeTalkingSeries(dailySeries, dailySeriesCarry)}
          variant="area"
          tone="purple"
          unit="min"
          valueFormat={formatMinutes}
          emptyLabel="No spoken time recorded yet."
        />

        <TimeSeriesChart
          title="Cumulative time saved"
          data={cumulativeTimeSavedSeries(dailySeries, dailySeriesCarry)}
          variant="area"
          tone="blue"
          unit="min"
          valueFormat={formatMinutes}
          emptyLabel="Time saved appears once you have recorded something."
        />

        <SentimentSection analytics={analytics} />
      </div>

      {/* Cumulative charts are seeded from `dailySeriesCarry`, so they continue
          the history rather than restarting at zero where the 365-day window
          truncates. Say so, or the first point reads as a mystery jump. */}
      {carry ? (
        <p className="px-1 text-[10px] text-text-faint">
          {`Cumulative charts are seeded from ${formatMinutes(dailySeriesCarry.durationSeconds / 60)} of talking and ${formatMinutes(dailySeriesCarry.timeSavedMinutes)} saved before the charted window (${carry}).`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Sentiment is the one section that must not render its own numbers unchecked.
 * `averageSentiment` is a mean over scored rows and is `0` when nothing is
 * scored, which is byte-identical to a genuinely neutral corpus; and per-day
 * `avgSentiment` is `null` on unscored days, which must never be plotted as 0.
 */
function SentimentSection({ analytics }: { analytics: DictationAnalytics }) {
  const display = sentimentDisplay(analytics);

  if (display.kind !== "scored") {
    return (
      <ChartFrame
        title="Sentiment over time"
        summary={`Sentiment over time: ${display.message}`}
        caption={display.kind === "outside-window" ? display.coverageLabel : "not scored"}
        isEmpty
        emptyLabel={display.message}
      />
    );
  }

  return (
    <div className="space-y-1">
      <TimeSeriesChart
        title="Sentiment over time"
        data={display.points}
        variant="diverging"
        tone="green"
        negativeTone="red"
        valueFormat={formatSentiment}
      />
      <p className="px-1 text-[10px] text-text-faint">
        {`Mean ${formatSentiment(display.average)} over scored entries only — ${display.coverageLabel}. Unscored days are omitted, not counted as neutral.`}
      </p>
    </div>
  );
}
