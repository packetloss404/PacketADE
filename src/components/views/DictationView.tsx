import { useEffect, useState } from "react";
import { Mic, MicOff, Loader2, Check, BarChart3, Flame, Clock, Hash, BookOpen, TrendingUp, Search, ChevronDown, ChevronRight, Zap, SmilePlus, Timer, AlertTriangle, X } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  DEFAULT_TOGGLE_SHORTCUT,
  type DictationAnalytics,
  type DictationEntry,
} from "@/types/dictation";

/** How long a phase may run before the UI stops pretending it is healthy.
 *  A Bluetooth headset that walks out of range can leave `start_recording`
 *  blocked inside CPAL indefinitely, so a bare spinner is a dead end. */
const START_STALL_MS = 8_000;
const TRANSCRIBE_STALL_MS = 90_000;

export function DictationView() {
  const isStarting = useDictationStore((s) => s.isStarting);
  const isRecording = useDictationStore((s) => s.isRecording);
  const isTranscribing = useDictationStore((s) => s.isTranscribing);
  const lastResult = useDictationStore((s) => s.lastResult);
  const lastTelemetry = useDictationStore((s) => s.lastTelemetry);
  const error = useDictationStore((s) => s.error);
  const deliveryNotice = useDictationStore((s) => s.deliveryNotice);
  const waveform = useDictationStore((s) => s.waveform);
  const analytics = useDictationStore((s) => s.analytics);
  const history = useDictationStore((s) => s.history);
  const settings = useDictationStore((s) => s.settings);
  const shortcutStatus = useDictationStore((s) => s.shortcutStatus);
  const startRecording = useDictationStore((s) => s.startRecording);
  const stopRecording = useDictationStore((s) => s.stopRecording);
  const cancelRecording = useDictationStore((s) => s.cancelRecording);
  const loadAnalytics = useDictationStore((s) => s.loadAnalytics);
  const loadHistory = useDictationStore((s) => s.loadHistory);
  const loadSettings = useDictationStore((s) => s.loadSettings);
  const loadModels = useDictationStore((s) => s.loadModels);
  const searchHistory = useDictationStore((s) => s.searchHistory);
  const clearResult = useDictationStore((s) => s.clearResult);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"analytics" | "history">("analytics");
  const [stalledPhase, setStalledPhase] = useState<"starting" | "transcribing" | null>(null);

  useEffect(() => {
    loadAnalytics();
    loadHistory(100, 0);
    loadSettings();
    loadModels();
  }, [loadAnalytics, loadHistory, loadModels, loadSettings]);

  // Stall watchdog: turn an indefinite spinner into a stated, actionable state.
  useEffect(() => {
    if (!isStarting && !isTranscribing) {
      setStalledPhase(null);
      return;
    }
    setStalledPhase(null);
    const phase: "starting" | "transcribing" = isStarting ? "starting" : "transcribing";
    const timer = window.setTimeout(
      () => setStalledPhase(phase),
      phase === "starting" ? START_STALL_MS : TRANSCRIBE_STALL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isStarting, isTranscribing]);

  async function handleToggleRecording() {
    if (isRecording) {
      await stopRecording();
    } else {
      clearResult();
      await startRecording();
    }
  }

  const recordLabel = isRecording
    ? "Stop recording and transcribe"
    : isStarting
      ? "Opening the microphone"
      : isTranscribing
        ? "Transcribing"
        : "Start recording";

  function handleSearch() {
    if (searchQuery.trim()) {
      searchHistory(searchQuery.trim());
    } else {
      loadHistory(100, 0);
    }
  }

  const bars: number[] = waveform && waveform.length > 0 ? waveform.slice(0, 32) : Array(32).fill(0);

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary" data-dictation="off">
      {/* Left: Recording area */}
      <div className="w-[340px] flex-shrink-0 flex flex-col items-center border-r border-bg-border bg-bg-secondary px-6 py-8">
        <div className="w-full max-w-[280px] space-y-6">
          <div className="flex items-center gap-2">
            <Mic size={16} className="text-accent-green" aria-hidden="true" />
            <h1 className="text-sm font-semibold text-text-primary">Dictation</h1>
          </div>

          {/* Record button */}
          <div className="flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={handleToggleRecording}
              disabled={isStarting || isTranscribing}
              aria-label={recordLabel}
              aria-pressed={isRecording}
              aria-busy={isStarting || isTranscribing}
              className={[
                "w-20 h-20 rounded-full flex items-center justify-center transition-all",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green",
                isRecording
                  ? "bg-accent-red/20 border-2 border-accent-red text-accent-red animate-pulse shadow-lg shadow-accent-red/20"
                  : isStarting || isTranscribing
                  ? "bg-accent-amber/20 border-2 border-accent-amber text-accent-amber cursor-wait"
                  : "bg-accent-green/15 border-2 border-accent-green/40 text-accent-green hover:bg-accent-green/25 hover:border-accent-green/60",
              ].join(" ")}
            >
              {isStarting || isTranscribing ? (
                <Loader2 size={28} className="animate-spin" aria-hidden="true" />
              ) : isRecording ? (
                <MicOff size={28} aria-hidden="true" />
              ) : (
                <Mic size={28} aria-hidden="true" />
              )}
            </button>
            <span className="text-[11px] text-text-muted text-center" role="status" aria-live="polite">
              {isRecording
                ? "Recording — click to stop, Escape to discard"
                : isStarting
                ? "Opening microphone…"
                : isTranscribing
                ? "Transcribing…"
                : idleHint(shortcutStatus.state, settings?.toggleShortcut, settings?.pushToTalkShortcut)}
            </span>

            {/* Escape hatch. The record button is disabled while starting and
                transcribing, so without this a wedged capture leaves no route
                back to idle. `cancelRecording` resets both phases. */}
            {(isStarting || isRecording || isTranscribing) && (
              <button
                type="button"
                onClick={() => void cancelRecording()}
                aria-label={
                  isTranscribing ? "Cancel transcription and discard the audio" : "Cancel recording"
                }
                className="px-3 py-1 text-[11px] text-text-secondary border border-bg-border rounded-lg transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green"
              >
                Cancel
              </button>
            )}
          </div>

          {stalledPhase && (
            <div
              className="px-4 py-3 bg-accent-amber/5 border border-accent-amber/20 rounded-lg"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={12} className="text-accent-amber shrink-0 mt-[1px]" aria-hidden="true" />
                <p className="text-[11px] text-accent-amber break-words">
                  {stalledPhase === "starting"
                    ? "The microphone still has not opened. A Bluetooth headset that has gone out of range, or a device held by another application, hangs here. Cancel is queued until the device answers; the open gives up on its own shortly. Re-run the microphone test in Tools → Dictation afterwards."
                    : "Transcription is still running. Large Whisper models on long recordings can take this long — press Cancel to discard the audio and return to idle."}
                </p>
              </div>
            </div>
          )}

          {/* Waveform */}
          {isRecording && (
            <div className="flex items-end justify-center gap-[2px] h-12" aria-hidden="true">
              {bars.map((level, i) => (
                <div
                  key={i}
                  className="w-1.5 bg-accent-green/60 rounded-full transition-all duration-75"
                  style={{ height: Math.max(4, level * 48) + "px" }}
                />
              ))}
            </div>
          )}

          {/* Result. Gated on capture state rather than the transient `status`
              string: a stray backend status event must not erase a transcript
              the user has not read yet. */}
          {lastResult && !isRecording && !isStarting && (
            <div className="px-4 py-3 bg-bg-primary border border-bg-border rounded-lg">
              <div className="flex items-center gap-1.5 mb-2">
                <Check size={10} className="text-accent-green" />
                <span className="text-[10px] font-medium text-accent-green">Transcription</span>
              </div>
              <p className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
                {lastResult}
              </p>
              {lastTelemetry && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-bg-border pt-2 text-[9px] text-text-muted">
                  <span>{lastTelemetry.modelSize} model</span>
                  <span>
                    {lastTelemetry.inputSampleRate / 1000} kHz / {lastTelemetry.channels} ch
                  </span>
                  {lastTelemetry.detectedLanguage && (
                    <span>language {lastTelemetry.detectedLanguage}</span>
                  )}
                  <span>inference {lastTelemetry.inferenceMs} ms</span>
                  {lastTelemetry.modelLoadMs > 0 && (
                    <span>model load {lastTelemetry.modelLoadMs} ms</span>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div
              className="px-4 py-3 bg-accent-red/5 border border-accent-red/20 rounded-lg"
              role="alert"
            >
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[11px] text-accent-red break-words whitespace-pre-wrap">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={clearResult}
                  aria-label="Dismiss dictation error"
                  className="shrink-0 text-accent-red/70 transition-colors hover:text-accent-red focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-red"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {deliveryNotice && (
            <div
              className="px-4 py-3 bg-accent-blue/5 border border-accent-blue/20 rounded-lg"
              role="status"
              aria-live="polite"
            >
              <p className="text-[11px] text-accent-blue break-words">{deliveryNotice}</p>
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
        <div
          className="flex items-center gap-1 px-4 py-2 border-b border-bg-border bg-bg-secondary"
          role="tablist"
          aria-label="Dictation panels"
        >
          <button
            type="button"
            role="tab"
            id="dictation-tab-analytics"
            aria-selected={activeTab === "analytics"}
            aria-controls="dictation-tabpanel"
            onClick={() => setActiveTab("analytics")}
            className={`px-3 py-1 text-[11px] rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green ${
              activeTab === "analytics"
                ? "bg-bg-elevated text-accent-green font-medium"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <BarChart3 size={10} className="inline mr-1" aria-hidden="true" />
            Analytics
          </button>
          <button
            type="button"
            role="tab"
            id="dictation-tab-history"
            aria-selected={activeTab === "history"}
            aria-controls="dictation-tabpanel"
            onClick={() => setActiveTab("history")}
            className={`px-3 py-1 text-[11px] rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green ${
              activeTab === "history"
                ? "bg-bg-elevated text-accent-green font-medium"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <Clock size={10} className="inline mr-1" aria-hidden="true" />
            History
            {history.length > 0 && (
              <span className="ml-1 text-[9px] text-text-muted">({history.length})</span>
            )}
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto p-4"
          role="tabpanel"
          id="dictation-tabpanel"
          aria-labelledby={
            activeTab === "analytics" ? "dictation-tab-analytics" : "dictation-tab-history"
          }
        >
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
        <StatCard icon={Zap} label="Fastest WPM" value={String(analytics.fastestWpm)} color="text-accent-amber" />
        <StatCard icon={SmilePlus} label="Avg Sentiment" value={sentimentLabel(analytics.averageSentiment)} color={sentimentColor(analytics.averageSentiment)} />
        <StatCard icon={Timer} label="Total Time" value={formatDuration(analytics.totalDurationMinutes)} color="text-accent-blue" />
        <StatCard icon={BookOpen} label="Entries" value={String(analytics.totalEntries)} color="text-accent-purple" />
        <StatCard icon={Flame} label="Daily Streak" value={`${analytics.dailyStreak} days`} color="text-accent-amber" />
        <StatCard icon={Clock} label="Time Saved" value={`${Math.round(analytics.timeSavedMinutes)} min`} color="text-accent-green" />
        <StatCard icon={BarChart3} label="Vocab Diversity" value={`${Math.round(analytics.vocabularyDiversity * 100)}%`} color="text-text-secondary" />
      </div>

      {/* Sentiment over time (from history entries) */}
      {history.filter((e) => e.sentiment != null).length > 1 && (
        <div className="bg-bg-secondary border border-bg-border rounded-lg p-4">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Sentiment Over Time</span>
          <div className="relative h-16 mt-3">
            {/* Neutral line */}
            <div className="absolute left-0 right-0 top-1/2 border-t border-bg-border border-dashed" />
            <div className="flex items-center gap-[2px] h-full">
              {history
                .filter((e) => e.sentiment != null)
                .slice(-50)
                .map((entry, i) => {
                  // Sentiment ranges from -1 (negative) to +1 (positive), 0 = neutral
                  const s = entry.sentiment ?? 0;
                  const isPositive = s >= 0;
                  const magnitude = Math.abs(s) * 50; // 50% of height max
                  return (
                    <div
                      key={entry.id ?? i}
                      className="flex-1 min-w-[3px] max-w-[12px] relative h-full flex items-center"
                    >
                      <div
                        className={`w-full rounded-sm transition-colors ${
                          isPositive
                            ? "bg-accent-green/50 hover:bg-accent-green/80"
                            : "bg-accent-red/50 hover:bg-accent-red/80"
                        }`}
                        style={{
                          height: `${Math.max(2, magnitude)}%`,
                          position: "absolute",
                          ...(isPositive
                            ? { bottom: "50%", left: 0, right: 0 }
                            : { top: "50%", left: 0, right: 0 }),
                        }}
                        title={`${s > 0 ? "+" : ""}${s.toFixed(2)} — ${formatTimestamp(entry.timestamp)}`}
                      />
                    </div>
                  );
                })}
            </div>
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[8px] text-text-muted">Oldest</span>
            <span className="text-[8px] text-accent-green">Positive</span>
            <span className="text-[8px] text-accent-red">Negative</span>
            <span className="text-[8px] text-text-muted">Recent</span>
          </div>
        </div>
      )}

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
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            placeholder="Search transcriptions..."
            aria-label="Search transcription history"
            className="w-full pl-8 pr-3 py-1.5 bg-bg-secondary border border-bg-border rounded-lg text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-green"
          />
        </div>
        <button
          type="button"
          onClick={onSearch}
          className="px-3 py-1.5 text-[11px] text-accent-green hover:bg-accent-green/10 border border-bg-border rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green"
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
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green"
                >
                  {isExpanded ? (
                    <ChevronDown size={10} className="text-text-muted shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight size={10} className="text-text-muted shrink-0" aria-hidden="true" />
                  )}
                  <span className="text-[11px] text-text-primary truncate flex-1">
                    {entry.text.slice(0, 80)}{entry.text.length > 80 ? "..." : ""}
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    {entry.sentiment != null && (
                      <span className={`text-[9px] ${sentimentColor(entry.sentiment)}`}>
                        {sentimentEmoji(entry.sentiment)}
                      </span>
                    )}
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
                      {entry.sentiment != null && (
                        <span className={sentimentColor(entry.sentiment)}>
                          Sentiment: {entry.sentiment > 0 ? "+" : ""}{entry.sentiment.toFixed(2)} {sentimentEmoji(entry.sentiment)}
                        </span>
                      )}
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

/** Render an accelerator string the way the OS labels it. Mirrors the
 *  formatting in `KeyboardShortcutsCard`. */
function formatAccelerator(accelerator: string): string {
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  return accelerator
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl") return isMac ? "Cmd" : "Ctrl";
      if (part === "Control") return "Ctrl";
      return part;
    })
    .join("+");
}

/** Only advertise a keyboard route to recording when one is actually
 *  registered. Global dictation shortcuts are opt-in and off by default
 *  (DV13); claiming a chord that is not bound sends the user hunting for a
 *  key that does nothing. */
function idleHint(
  shortcutState: "disabled" | "registering" | "ready" | "error",
  toggleShortcut: string | undefined,
  pushToTalkShortcut: string | undefined,
): string {
  if (shortcutState !== "ready") {
    return "Click to record. Global shortcuts are off — enable them in Tools → Keyboard Shortcuts.";
  }
  const toggle = formatAccelerator(toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT);
  const pushToTalk = formatAccelerator(pushToTalkShortcut ?? DEFAULT_PUSH_TO_TALK_SHORTCUT);
  return `Click, ${toggle} to toggle, or hold ${pushToTalk}`;
}

function sentimentLabel(s: number): string {
  if (s >= 0.3) return "Positive";
  if (s >= 0.1) return "Slightly +";
  if (s <= -0.3) return "Negative";
  if (s <= -0.1) return "Slightly -";
  return "Neutral";
}

function sentimentColor(s: number): string {
  if (s >= 0.3) return "text-accent-green";
  if (s >= 0.1) return "text-accent-green";
  if (s <= -0.3) return "text-accent-red";
  if (s <= -0.1) return "text-accent-amber";
  return "text-text-muted";
}

function sentimentEmoji(s: number): string {
  if (s >= 0.3) return "+";
  if (s >= 0.1) return "+";
  if (s <= -0.3) return "-";
  if (s <= -0.1) return "-";
  return "~";
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
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
