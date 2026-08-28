/**
 * When you dictate: the two heatmaps and the two hour-of-day bar charts.
 *
 * Every bucket here is **UTC**, because the Rust aggregator has no tz database
 * and the streak, goal, and "this week" figures are bucketed the same way.
 * Re-bucketing to local time in the UI would make this panel disagree with the
 * numbers beside it, so the labels say UTC instead.
 */

import { BarSeries, HeatmapGrid } from "./charts";
import {
  WEEKDAY_LABELS,
  buildYearlyHeatmap,
  hourAxisLabels,
  hourBars,
  wpmHourBars,
} from "./analytics-derive";
import type { DictationAnalytics } from "@/types/dictation";

const HOUR_LABELS = hourAxisLabels();

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00 UTC`;
}

export function AnalyticsRhythm({ analytics }: { analytics: DictationAnalytics }) {
  const yearly = buildYearlyHeatmap(analytics.dailySeries);

  return (
    <div className="space-y-3">
      <HeatmapGrid
        title="Daily activity"
        rows={yearly.rows}
        rowLabels={[...WEEKDAY_LABELS]}
        columnLabels={yearly.columnLabels}
        cellSize={10}
        tone="green"
        unit="entries"
        cellLabel={(row, column) => yearly.cellDates[row]?.[column] ?? "—"}
        emptyLabel="Nothing recorded yet. Each square becomes one UTC day once you start."
      />

      <HeatmapGrid
        title="Week by hour (UTC)"
        rows={analytics.activityMatrix}
        rowLabels={[...WEEKDAY_LABELS]}
        columnLabels={HOUR_LABELS}
        cellSize={12}
        tone="purple"
        unit="entries"
        cellLabel={(row, column) => `${WEEKDAY_LABELS[row] ?? "?"} ${hourLabel(column)}`}
        emptyLabel="No sessions recorded yet."
      />

      <div className="grid gap-3 md:grid-cols-2">
        <BarSeries
          title="Peak hours (UTC)"
          data={hourBars(analytics.hourlyActivity)}
          orientation="vertical"
          tone="green"
          axisLabels={HOUR_LABELS}
          unit="entries"
          emptyLabel="No sessions recorded yet."
        />

        <BarSeries
          title="Speed by hour (UTC)"
          data={wpmHourBars(analytics.wpmByHour)}
          orientation="vertical"
          tone="blue"
          axisLabels={HOUR_LABELS}
          unit="wpm"
          emptyLabel="No hour has a recorded speaking rate yet."
        />
      </div>

      <p className="px-1 text-[10px] text-text-faint">
        Hours and weekdays are bucketed in UTC, matching the streak and weekly-goal
        figures. Hours with no reading show as an empty tick rather than a zero bar.
      </p>
    </div>
  );
}
