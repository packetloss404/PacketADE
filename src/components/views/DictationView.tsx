import { useEffect } from "react";
import { Mic, MicOff, Loader2, Check, BarChart3, Flame, Clock, Hash, BookOpen, TrendingUp } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import type { DictationAnalytics } from "@/types/dictation";

export function DictationView() {
  const isRecording = useDictationStore((s) => s.isRecording);
  const isTranscribing = useDictationStore((s) => s.isTranscribing);
  const lastResult = useDictationStore((s) => s.lastResult);
  const status = useDictationStore((s) => s.status);
  const error = useDictationStore((s) => s.error);
  const waveform = useDictationStore((s) => s.waveform);
  const analytics = useDictationStore((s) => s.analytics);
  const startRecording = useDictationStore((s) => s.startRecording);
  const stopRecording = useDictationStore((s) => s.stopRecording);
  const loadAnalytics = useDictationStore((s) => s.loadAnalytics);
  const clearResult = useDictationStore((s) => s.clearResult);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  async function handleToggleRecording() {
    if (isRecording) {
      await stopRecording();
      // Refresh analytics after transcription
      setTimeout(() => loadAnalytics(), 500);
    } else {
      clearResult();
      await startRecording();
    }
  }

  const bars: number[] = waveform && waveform.length > 0 ? waveform.slice(0, 32) : Array(32).fill(0);

  return (
    <div className="flex flex-1 overflow-hidden bg-bg-primary">
      {/* Left: Recording area */}
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <div className="w-full max-w-[400px] space-y-6">
          {/* Header */}
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
                : "Click to start recording"}
            </span>
          </div>

          {/* Waveform visualization */}
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
            <div className="px-4 py-3 bg-bg-secondary border border-bg-border rounded-lg">
              <div className="flex items-center gap-1.5 mb-2">
                <Check size={10} className="text-accent-green" />
                <span className="text-[10px] font-medium text-accent-green">Transcription</span>
              </div>
              <p className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
                {lastResult}
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-4 py-3 bg-accent-red/5 border border-accent-red/20 rounded-lg">
              <p className="text-[11px] text-accent-red">{error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Right: Analytics panel */}
      <div className="w-[320px] flex-shrink-0 border-l border-bg-border bg-bg-secondary overflow-y-auto p-4">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 size={12} className="text-accent-purple" />
          <h2 className="text-xs font-semibold text-text-primary">Analytics</h2>
        </div>

        {analytics ? (
          <AnalyticsPanel analytics={analytics} />
        ) : (
          <p className="text-[10px] text-text-muted text-center py-8">
            No dictation data yet. Start recording to see analytics.
          </p>
        )}
      </div>
    </div>
  );
}

function AnalyticsPanel({ analytics }: { analytics: DictationAnalytics }) {
  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={Hash} label="Total Words" value={analytics.totalWords.toLocaleString()} color="text-accent-green" />
        <StatCard icon={TrendingUp} label="Avg WPM" value={Math.round(analytics.averageWpm).toString()} color="text-accent-blue" />
        <StatCard icon={Flame} label="Daily Streak" value={`${analytics.dailyStreak}d`} color="text-accent-amber" />
        <StatCard icon={Clock} label="Time Saved" value={`${analytics.timeSavedMinutes}m`} color="text-accent-purple" />
      </div>

      {/* More stats */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={BookOpen} label="Entries" value={analytics.totalEntries.toString()} color="text-text-secondary" />
        <StatCard icon={BarChart3} label="Vocab Diversity" value={`${Math.round(analytics.vocabularyDiversity * 100)}%`} color="text-accent-cyan" />
      </div>

      {/* Hourly activity */}
      {analytics.hourlyActivity.length > 0 && (
        <div className="bg-bg-primary border border-bg-border rounded-lg p-3">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Activity by Hour</span>
          <div className="flex items-end gap-[2px] h-10 mt-2">
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

      {/* Top words */}
      {analytics.topWords.length > 0 && (
        <div className="bg-bg-primary border border-bg-border rounded-lg p-3">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Top Words</span>
          <div className="mt-2 space-y-1">
            {analytics.topWords.slice(0, 8).map(([word, count]) => {
              const max = analytics.topWords[0]?.[1] ?? 1;
              const pct = (count / max) * 100;
              return (
                <div key={word} className="flex items-center gap-2">
                  <span className="text-[10px] text-text-secondary w-16 truncate">{word}</span>
                  <div className="flex-1 h-1.5 bg-bg-border rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent-purple/50 rounded-full"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[9px] text-text-muted w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Mode breakdown */}
      {Object.keys(analytics.modeBreakdown).length > 0 && (
        <div className="bg-bg-primary border border-bg-border rounded-lg p-3">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Mode Breakdown</span>
          <div className="mt-2 space-y-1">
            {Object.entries(analytics.modeBreakdown).map(([mode, count]) => (
              <div key={mode} className="flex items-center justify-between">
                <span className="text-[10px] text-text-secondary capitalize">{mode}</span>
                <span className="text-[10px] text-text-muted">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
    <div className="bg-bg-primary border border-bg-border rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={10} className={color} />
        <span className="text-[9px] text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}
