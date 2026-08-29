/**
 * The dictation Analytics tab.
 *
 * Composes the 21 portable visualisations from the three chart primitives in
 * `./charts` plus plain markup for the four that are numbers and lists. The
 * primitive-to-visualisation mapping, and the reasoning behind the hand-rolled
 * primitives, are recorded in `dev/dictation-analytics-charting.md`.
 *
 * Section split, mirrored by the file layout:
 * - headline totals, streaks, records, goals, this-week comparison (here)
 * - `AnalyticsTrends` — the six time-series charts and the sentiment gate
 * - `AnalyticsRhythm` — both heatmaps and the two hour-of-day bar charts
 * - `AnalyticsVocabulary` — ranked word/phrase lists, new words, reading level
 */

import {
  BarChart3,
  BookOpen,
  Clock,
  Flame,
  Globe,
  Hash,
  Mic,
  Timer,
  Trophy,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { DictationAnalytics } from "@/types/dictation";
import { useAppStore } from "@/stores/appStore";
import { resolvedTimeZone, timeZoneOffsetLabel, timeZoneOffsetMinutes } from "@/lib/time";
import { BarSeries, ChartFrame } from "./charts";
import { AnalyticsRhythm } from "./AnalyticsRhythm";
import { AnalyticsTrends } from "./AnalyticsTrends";
import { AnalyticsVocabulary } from "./AnalyticsVocabulary";
import {
  formatMinutes,
  formatSeconds,
  formatSentiment,
  periodComparisonBars,
  periodComparisonMax,
  sentimentDisplay,
  sentimentToneClass,
} from "./analytics-derive";

export function AnalyticsPanel({ analytics }: { analytics: DictationAnalytics }) {
  if (analytics.totalEntries === 0) {
    return <AnalyticsEmptyState />;
  }

  return (
    <div className="max-w-[860px] space-y-5">
      <UtcBucketNote />
      <Headline analytics={analytics} />
      <Section title="Trends">
        <AnalyticsTrends analytics={analytics} />
      </Section>
      <Section title="Rhythm">
        <AnalyticsRhythm analytics={analytics} />
      </Section>
      <Section title="Consistency">
        <Streaks analytics={analytics} />
        <Goals analytics={analytics} />
      </Section>
      <Section title="Language">
        <AnalyticsVocabulary analytics={analytics} />
      </Section>
      <Section title="Records">
        <Records analytics={analytics} />
      </Section>
    </div>
  );
}

/**
 * A fresh install has nothing to chart. Twenty-one empty frames is a worse
 * answer than one paragraph that says what will show up and how to get it.
 */
function AnalyticsEmptyState() {
  return (
    <div className="max-w-[520px] rounded-lg border border-bg-border bg-bg-secondary p-6">
      <div className="flex items-center gap-2">
        <Mic size={14} className="text-accent-green" aria-hidden="true" />
        <h2 className="text-xs font-semibold text-text-primary">No transcriptions yet</h2>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
        Record something and this tab fills in. From the first entry you get totals,
        speed, and time saved; a day or two of use adds the daily trend lines, the
        activity heatmaps, and your peak hours; a week adds streaks, goals, and the
        this-week-versus-last-week comparison.
      </p>
      <ul className="mt-3 space-y-1 text-[11px] text-text-muted">
        <li>Words, speed, and vocabulary growth over time</li>
        <li>When you dictate, by UTC weekday and hour</li>
        <li>Most-used words, filler words, and repeated phrases</li>
      </ul>
      <p className="mt-3 text-[10px] text-text-faint">
        All calendar buckets are UTC. Sentiment is scored only for recordings made
        after the scorer was added, so it stays empty on older history.
      </p>
    </div>
  );
}

/**
 * States, on the tab itself, that the calendar buckets are UTC.
 *
 * The backend buckets every date-derived figure here — streaks, "today",
 * "this week", the hour-of-day and weekday heatmaps — in UTC, because
 * `src-tauri` carries no tz database and shipping the whole transcript corpus
 * to the frontend to re-bucket it is exactly what `analytics.rs` refuses to
 * do. Meanwhile the History tab renders each timestamp in the zone configured
 * in Tools → Date & Time, so an entry recorded either side of midnight there
 * lands in a different day on the two tabs. That was documented only in the
 * Date & Time card, which is not where anyone reads a streak.
 *
 * Rendered only when the effective zone actually has a non-zero offset: at
 * UTC+00:00 the buckets and the timestamps agree and the note would be noise.
 */
function UtcBucketNote() {
  // Subscribed, not read imperatively: `resolvedTimeZone` goes through
  // `getState()`, so without this the note would keep naming the old zone
  // until something else re-rendered the tab.
  useAppStore((s) => s.timeZone);
  const zone = resolvedTimeZone();
  if (timeZoneOffsetMinutes(zone) === 0) return null;

  return (
    <p
      className="flex items-start gap-1.5 rounded border border-bg-border bg-bg-secondary px-3 py-2 text-[10px] leading-snug text-text-muted"
      role="note"
    >
      <Globe size={11} className="mt-[1px] shrink-0" aria-hidden="true" />
      <span>
        Days, weeks and hours on this tab are counted in{" "}
        <span className="font-mono text-text-secondary">UTC</span>, not in{" "}
        <span className="font-mono text-text-secondary">{zone}</span> (
        {timeZoneOffsetLabel(zone)}), the zone History timestamps use. An entry
        recorded near midnight can therefore fall on a different day in the two
        tabs.
      </span>
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

/* ── Headline totals ── */

function Headline({ analytics }: { analytics: DictationAnalytics }) {
  const sentiment = sentimentDisplay(analytics);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatTile
        icon={Hash}
        label="Total words"
        value={analytics.totalWords.toLocaleString()}
        tone="text-accent-green"
      />
      <StatTile
        icon={BookOpen}
        label="Entries"
        value={analytics.totalEntries.toLocaleString()}
        tone="text-accent-purple"
      />
      <StatTile
        icon={TrendingUp}
        label="Average speed"
        value={`${Math.round(analytics.averageWpm)} wpm`}
        tone="text-accent-blue"
      />
      <StatTile
        icon={Timer}
        label="Time spoken"
        value={formatMinutes(analytics.totalDurationMinutes)}
        tone="text-accent-blue"
      />
      <StatTile
        icon={Clock}
        label="Time saved"
        value={formatMinutes(analytics.timeSavedMinutes)}
        tone="text-accent-green"
        note="vs typing at 40 wpm"
      />
      <StatTile
        icon={BarChart3}
        label="Vocabulary diversity"
        value={`${Math.round(analytics.vocabularyDiversity * 100)}%`}
        tone="text-accent-amber"
        note="distinct words / total"
      />
      {/* `averageSentiment` is 0 when nothing is scored, which is
          indistinguishable from a neutral corpus — so the tile only exists once
          coverage confirms there is something to average. */}
      {sentiment.kind === "scored" ? (
        <StatTile
          icon={Flame}
          label="Average sentiment"
          value={formatSentiment(sentiment.average)}
          tone={sentimentToneClass(sentiment.average)}
          note={sentiment.coverageLabel}
        />
      ) : null}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
  note,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  tone: string;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-secondary px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon size={12} className={tone} aria-hidden="true" />
        <span className="text-[9px] uppercase tracking-wider text-text-muted">{label}</span>
      </div>
      <span className={`text-sm font-semibold ${tone}`}>{value}</span>
      {note ? <p className="mt-0.5 text-[10px] text-text-faint">{note}</p> : null}
    </div>
  );
}

/* ── Streaks ── */

/**
 * `currentStreak` and `dailyStreak` are genuinely different fields and are
 * shown as such. The first requires an entry today or yesterday and is 0
 * otherwise; the second is the run ending at the last active day, however long
 * ago that was. Collapsing them would either overstate a lapsed habit or hide a
 * live one.
 */
function Streaks({ analytics }: { analytics: DictationAnalytics }) {
  const { currentStreak, longestStreak, dailyStreak } = analytics;
  const lapsed = currentStreak === 0 && dailyStreak > 0;

  return (
    <ChartFrame
      title="Streaks"
      summary={
        currentStreak > 0
          ? `Streaks: ${currentStreak} day current streak, ${longestStreak} day best.`
          : `Streaks: no active streak. Last run was ${dailyStreak} day${dailyStreak === 1 ? "" : "s"}; best ever ${longestStreak}.`
      }
      caption="UTC days"
    >
      <div className="grid grid-cols-3 gap-3">
        <StreakStat
          value={currentStreak}
          label="Current"
          note="Ends today or yesterday"
          tone={currentStreak > 0 ? "text-accent-green" : "text-text-muted"}
        />
        <StreakStat
          value={longestStreak}
          label="Longest"
          note="Best run ever"
          tone="text-accent-amber"
        />
        <StreakStat
          value={dailyStreak}
          label="Last run"
          note="Ends at your last active day"
          tone="text-accent-purple"
        />
      </div>
      {lapsed ? (
        <p className="mt-2 text-[10px] text-text-faint">
          {`Your last run reached ${dailyStreak} day${dailyStreak === 1 ? "" : "s"} but did not include today or yesterday, so the current streak is zero.`}
        </p>
      ) : null}
    </ChartFrame>
  );
}

function StreakStat({
  value,
  label,
  note,
  tone,
}: {
  value: number;
  label: string;
  note: string;
  tone: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1">
        <span className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</span>
        <span className="text-[10px] text-text-muted">{value === 1 ? "day" : "days"}</span>
      </div>
      <div className="text-[11px] text-text-secondary">{label}</div>
      <div className="text-[10px] text-text-faint">{note}</div>
    </div>
  );
}

/* ── Goals and period comparison ── */

function Goals({ analytics }: { analytics: DictationAnalytics }) {
  const { dailyWordGoal, weeklyWordGoal, todayWords, thisWeek, lastWeek } = analytics;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {dailyWordGoal > 0 ? (
        <BarSeries
          title="Daily goal (UTC)"
          data={[
            {
              label: "Today",
              value: todayWords,
              tone: todayWords >= dailyWordGoal ? "green" : "blue",
              note: `of ${dailyWordGoal.toLocaleString()}`,
            },
          ]}
          orientation="horizontal"
          maxValue={dailyWordGoal}
          unit="words"
          emptyLabel="Nothing dictated today yet."
        />
      ) : null}

      {weeklyWordGoal > 0 ? (
        <BarSeries
          title="Weekly goal (UTC)"
          data={[
            {
              label: "This week",
              value: thisWeek.words,
              tone: thisWeek.words >= weeklyWordGoal ? "green" : "blue",
              note: `of ${weeklyWordGoal.toLocaleString()}`,
            },
          ]}
          orientation="horizontal"
          maxValue={weeklyWordGoal}
          unit="words"
          emptyLabel="Nothing dictated this week yet."
        />
      ) : null}

      <BarSeries
        title="This week vs last"
        data={periodComparisonBars(thisWeek, lastWeek)}
        orientation="horizontal"
        maxValue={periodComparisonMax(thisWeek, lastWeek)}
        unit="words"
        className="md:col-span-2"
        emptyLabel="Nothing dictated in either week."
      />
    </div>
  );
}

/* ── Records ── */

function Records({ analytics }: { analytics: DictationAnalytics }) {
  const records: { label: string; value: string; icon: ComponentType<{ size?: number; className?: string }> }[] = [
    { label: "Fastest speed", value: `${analytics.fastestWpm} wpm`, icon: Zap },
    {
      label: "Most words in a day",
      value: analytics.maxWordsInDay.toLocaleString(),
      icon: Trophy,
    },
    {
      label: "Longest entry",
      value: `${analytics.longestEntryWords.toLocaleString()} words`,
      icon: BookOpen,
    },
    {
      label: "Longest session",
      value: formatSeconds(analytics.longestSessionSeconds),
      icon: Timer,
    },
  ];

  return (
    <ChartFrame
      title="Personal records"
      summary={`Personal records: fastest ${analytics.fastestWpm} wpm, best day ${analytics.maxWordsInDay} words, longest entry ${analytics.longestEntryWords} words.`}
      columns={[
        { key: "label", label: "Record" },
        { key: "value", label: "Value", numeric: true },
      ]}
      rows={records.map((record) => ({ label: record.label, value: record.value }))}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        {records.map((record) => (
          <div key={record.label}>
            <div className="mb-1 flex items-center gap-1.5">
              <record.icon size={12} className="text-accent-amber" aria-hidden="true" />
              <span className="text-[9px] uppercase tracking-wider text-text-muted">
                {record.label}
              </span>
            </div>
            <span className="text-sm font-semibold text-text-primary">{record.value}</span>
          </div>
        ))}
      </div>
    </ChartFrame>
  );
}
