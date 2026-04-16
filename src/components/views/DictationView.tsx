import { useEffect, useState } from "react";
import { Mic, MicOff, Loader2, Check, BarChart3, Flame, Clock, Hash, BookOpen, TrendingUp, Search, ChevronDown, ChevronRight } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import type { DictationAnalytics, DictationEntry } from "@/types/dictation";

export function DictationView() {
  const isRecording = useDictationStore((s) => s.isRecording);
  const isTranscribing = useDictationStore((s) => s.isTranscribing);
  const lastResult = useDictationStore((s) => s.lastResult);
  const status = useDictationStore((s) => s.status);
  const error = useDictationStore((s) => s.error);
  const waveform = useDictationStore((s) => s.waveform);
  const analytics = useDictationStore((s) => s.analytics);
  const history = useDictationStore((s) => s.history);
  const startRecording = useDictationStore((s) => s.startRecording);
  const stopRecording = useDictationStore((s) => s.stopRecording);
  const loadAnalytics = useDictationStore((s) => s.loadAnalytics);
  const loadHistory = useDictationStore((s) => s.loadHistory);
  const searchHistory = useDictationStore((s) => s.searchHistory);
  const clearResult = useDictationStore((s) => s.clearResult);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"analytics" | "history">("analytics");

  useEffect(() => {
    loadAnalytics();
    loadHistory(100, 0);
  }, [loadAnalytics, loadHistory]);

  async function handleToggleRecording() {
    if (isRecording) {
      await stopRecording();
      setTimeout(() => {
        loadAnalytics();
        loadHistory(100, 0);
      }, 500);
    } else {
      clearResult();
      await startRecording();
    }
  }

  function handleSearch() {
    if (searchQuery.trim()) {
      searchHistory(searchQuery.trim());
    } else {
      loadHistory(100, 0);
    }
  }

  const bars: number[] = waveform && waveform.length > 0 ? waveform.slice(0, 32) : Array(32).fill(0);

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      {/* Left: Recording area */}
      <div className="w-[340px] flex-shrink-0 flex flex-col items-center border-r border-bg-border bg-bg-secondary px-6 py-8">
        <div className="w-full max-w-[280px] space-y-6">
          <div className="flex items-center gap-2">
            <Mic size={16} className="text-accent-green" />
            <h1 className="text-sm font-semibold text-text-primary">VibeToText</h1>
          </div>

          {/* Record button */}
          <div className="flex flex-col items-center gap-4">
            <button
              onClick={handleToggleRecording}
              disabled={isTranscribing}
              className={[
                "w-20 h-20 rounded-full flex items-center justify-center transition-all",
                isRecording
                  ? "bg-accent-red/20 border-2 border-accent-red text-accent-red animate-pulse shadow-lg shadow-accent-red/20"
                  : isTranscribing
                  ? "bg-accent-amber/20 border-2 border-accent-amber text-accent-amber cursor-wait"
                  : "bg-accent-green/15 border-2 border-accent-green/40 text-accent-green hover:bg-accent-green/25 hover:border-accent-green/60",
              ].join(" ")}
            >
              {isTranscribing ? (
                <Loader2 size={28} className="animate-spin" />
              ) : isRecording ? (
                <MicOff size={28} />
              ) : (
                <Mic size={28} />
              )}
            </button>
            <span className="text-[11px] text-text-muted">
              {isRecording
                ? "Recording... click to stop"
                : isTranscribing
                ? "Transcribing..."
                : "Click or Ctrl+Shift+V"}
            </span>
          </div>

          {/* Waveform */}
          {isRecording && (
            <div className="flex items-end justify-center gap-[2px] h-12">
              {bars.map((level, i) => (
                <div
                  key={i}
                  className="w-1.5 bg-accent-green/60 rounded-full transition-all duration-75"
                  style={{ height: Math.max(4, level * 48) + "px" }}
                />
              ))}
            </div>
          )}

          {/* Result */}
          {lastResult && status === "done" && (
            <div className="px-4 py-3 bg-bg-primary border border-bg-border rounded-lg">
              <div className="flex items-center gap-1.5 mb-2">
                <Check size={10} className="text-accent-green" />
                <span className="text-[10px] font-medium text-accent-green">Transcription</span>
              </div>
              <p className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
                {lastResult}
              </p>
            </div>
          )}

          {error && (
            <div className="px-4 py-3 bg-accent-red/5 border border-accent-red/20 rounded-lg">
              <p className="text-[11px] text-accent-red">{error}</p>
            </div>
          )}

          {/* Quick stats */}
          {analytics && (
            <div className="grid grid-cols-2 gap-2">
              <MiniStat label="Words" value={analytics.totalWords.toLocaleString()} />
              <MiniStat label="WPM" value={String(Math.round(analytics.averageWpm))} />
              <MiniStat label="Streak" value={`${analytics.dailyStreak}d`} />
              <MiniStat label="Saved" value={`${Math.round(analytics.timeSavedMinutes)}m`} />
            </div>
          )}
        </div>
      </div>

      {/* Right: Analytics + History */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-bg-border bg-bg-secondary">
          <button
            onClick={() => setActiveTab("analytics")}
            className={`px-3 py-1 text-[11px] rounded transition-colors ${
              activeTab === "analytics"
                ? "bg-bg-elevated text-accent-green font-medium"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <BarChart3 size={10} className="inline mr-1" />
            Analytics
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`px-3 py-1 text-[11px] rounded transition-colors ${
              activeTab === "history"
                ? "bg-bg-elevated text-accent-green font-medium"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <Clock size={10} className="inline mr-1" />
            History
            {history.length > 0 && (
              <span className="ml-1 text-[9px] text-text-muted">({history.length})</span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === "analytics" ? (
            analytics ? (
              <AnalyticsPanel analytics={analytics} history={history} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-text-muted">
                <BarChart3 size={24} className="mb-2 opacity-30" />
                <p className="text-[11px]">No data yet. Start recording to build analytics.</p>
              </div>
            )
          ) : (
            <HistoryPanel
              history={history}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onSearch={handleSearch}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-primary border border-bg-border rounded px-2 py-1.5 text-center">
      <div className="text-[9px] text-text-muted uppercase">{label}</div>
      <div className="text-xs font-semibold text-text-primary">{value}</div>
    </div>
  );
}

/* ── Analytics Panel ── */

function AnalyticsPanel({ analytics, history }: { analytics: DictationAnalytics; history: DictationEntry[] }) {
  return (
    <div className="space-y-4 max-w-[700px]">
      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={Hash} label="Total Words" value={analytics.totalWords.toLocaleString()} color="text-accent-green" />
        <StatCard icon={TrendingUp} label="Avg WPM" value={String(Math.round(analytics.averageWpm))} color="text-accent-blue" />
        <StatCard icon={BookOpen} label="Entries" value={String(analytics.totalEntries)} color="text-accent-purple" />
        <StatCard icon={Flame} label="Daily Streak" value={`${analytics.dailyStreak} days`} color="text-accent-amber" />
        <StatCard icon={Clock} label="Time Saved" value={`${Math.round(analytics.timeSavedMinutes)} min`} color="text-accent-cyan" />
        <StatCard icon={BarChart3} label="Vocab Diversity" value={`${Math.round(analytics.vocabularyDiversity * 100)}%`} color="text-text-secondary" />
      </div>

      {/* WPM over time chart (from history entries) */}
      {history.length > 1 && (
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">WPM Over Time</span>
          <div className="flex items-end gap-[2px] h-16 mt-3">
            {history
              .filter((e) => e.wpm != null && e.wpm > 0)
              .slice(-50)
              .map((entry, i) => {
                const maxWpm = Math.max(...history.filter((e) => e.wpm != null).map((e) => e.wpm!), 1);
                const pct = ((entry.wpm ?? 0) / maxWpm) * 100;
                return (
                  <div
                    key={entry.id ?? i}
                    className="flex-1 min-w-[3px] max-w-[12px] bg-accent-blue/40 hover:bg-accent-blue/70 rounded-t transition-colors"
                    style={{ height: `${Math.max(4, pct)}%` }}
                    title={`${entry.wpm} WPM — ${formatTimestamp(entry.timestamp)}`}
                  />
                );
              })}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[8px] text-text-muted">Oldest</span>
            <span className="text-[8px] text-text-muted">Most recent</span>
          </div>
        </div>
      )}

      {/* Hourly activity */}
      {analytics.hourlyActivity.some((v) => v > 0) && (
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Activity by Hour</span>
          <div className="flex items-end gap-[2px] h-12 mt-3">
            {analytics.hourlyActivity.map((count, hour) => {
              const max = Math.max(...analytics.hourlyActivity, 1);
              const height = (count / max) * 100;
              return (
                <div
                  key={hour}
                  className="flex-1 bg-accent-green/40 hover:bg-accent-green/70 rounded-t transition-colors"
                  style={{ height: `${Math.max(2, height)}%` }}
                  title={`${hour}:00 — ${count} entries`}
                />
              );
            })}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[8px] text-text-muted">12am</span>
            <span className="text-[8px] text-text-muted">6am</span>
            <span className="text-[8px] text-text-muted">12pm</span>
            <span className="text-[8px] text-text-muted">6pm</span>
            <span className="text-[8px] text-text-muted">12am</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {/* Top words */}
        {analytics.topWords.length > 0 && (
          <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Top Words</span>
            <div className="mt-2 space-y-1.5">
              {analytics.topWords.slice(0, 10).map(([word, count]) => {
                const max = analytics.topWords[0]?.[1] ?? 1;
                const pct = (count / max) * 100;
                return (
                  <div key={word} className="flex items-center gap-2">
                    <span className="text-[10px] text-text-secondary w-20 truncate font-mono">{word}</span>
                    <div className="flex-1 h-2 bg-bg-border rounded-full overflow-hidden">
                      <div className="h-full bg-accent-purple/50 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[9px] text-text-muted w-8 text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Mode breakdown + word count by entry */}
        <div className="space-y-4">
          {Object.keys(analytics.modeBreakdown).length > 0 && (
            <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Mode Breakdown</span>
              <div className="mt-2 space-y-1.5">
                {Object.entries(analytics.modeBreakdown)
                  .sort((a, b) => b[1] - a[1])
                  .map(([mode, count]) => {
                    const total = Object.values(analytics.modeBreakdown).reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return (
                      <div key={mode} className="flex items-center justify-between">
                        <span className="text-[11px] text-text-secondary capitalize">{mode}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-text-muted">{count}</span>
                          <span className="text-[9px] text-text-muted w-8 text-right">{pct}%</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Words per entry distribution */}
          {history.length > 0 && (
            <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Words per Entry</span>
              <div className="mt-2 space-y-1">
                {(() => {
                  const buckets = [
                    { label: "1-10", min: 1, max: 10, count: 0 },
                    { label: "11-25", min: 11, max: 25, count: 0 },
                    { label: "26-50", min: 26, max: 50, count: 0 },
                    { label: "51-100", min: 51, max: 100, count: 0 },
                    { label: "100+", min: 101, max: Infinity, count: 0 },
                  ];
                  for (const e of history) {
                    const wc = e.wordCount ?? 0;
                    for (const b of buckets) {
                      if (wc >= b.min && wc <= b.max) { b.count++; break; }
                    }
                  }
                  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
                  return buckets.map((b) => (
                    <div key={b.label} className="flex items-center gap-2">
                      <span className="text-[10px] text-text-muted w-12">{b.label}</span>
                      <div className="flex-1 h-2 bg-bg-border rounded-full overflow-hidden">
                        <div className="h-full bg-accent-amber/50 rounded-full" style={{ width: `${(b.count / maxCount) * 100}%` }} />
                      </div>
                      <span className="text-[9px] text-text-muted w-6 text-right">{b.count}</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── History Panel ── */

function HistoryPanel({
  history,
  searchQuery,
  onSearchChange,
  onSearch,
}: {
  history: DictationEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearch: () => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="space-y-3 max-w-[700px]">
      {/* Search bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            placeholder="Search transcriptions..."
            className="w-full pl-8 pr-3 py-1.5 bg-bg-secondary border border-bg-border rounded-lg text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
          />
        </div>
        <button
          onClick={onSearch}
          className="px-3 py-1.5 text-[11px] text-accent-green hover:bg-accent-green/10 border border-bg-border rounded-lg transition-colors"
        >
          Search
        </button>
      </div>

      {history.length === 0 ? (
        <p className="text-[11px] text-text-muted text-center py-8">No transcription history yet.</p>
      ) : (
        <div className="space-y-1">
          {history.map((entry) => {
            const isExpanded = expandedId === entry.id;
            return (
              <div
                key={entry.id}
                className="bg-bg-secondary border border-bg-border rounded-lg overflow-hidden"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown size={10} className="text-text-muted shrink-0" />
                  ) : (
                    <ChevronRight size={10} className="text-text-muted shrink-0" />
                  )}
                  <span className="text-[11px] text-text-primary truncate flex-1">
                    {entry.text.slice(0, 80)}{entry.text.length > 80 ? "..." : ""}
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    {entry.wpm != null && (
                      <span className="text-[9px] text-accent-blue">{entry.wpm} WPM</span>
                    )}
                    {entry.wordCount != null && (
                      <span className="text-[9px] text-text-muted">{entry.wordCount} words</span>
                    )}
                    <span className="text-[9px] text-text-muted">{formatTimestamp(entry.timestamp)}</span>
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-bg-border">
                    <p className="text-[11px] text-text-primary leading-relaxed whitespace-pre-wrap mb-2">
                      {entry.text}
                    </p>
                    <div className="flex items-center gap-4 text-[9px] text-text-muted">
                      <span>Mode: {entry.mode}</span>
                      {entry.durationSeconds != null && (
                        <span>Duration: {entry.durationSeconds.toFixed(1)}s</span>
                      )}
                      {entry.wpm != null && <span>WPM: {entry.wpm}</span>}
                      {entry.wordCount != null && <span>Words: {entry.wordCount}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Shared ── */

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-bg-secondary border border-bg-border rounded-lg px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={10} className={color} />
        <span className="text-[9px] text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return ts;
  }
}
