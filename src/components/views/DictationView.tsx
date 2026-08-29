import { useEffect, useState } from "react";
import { Mic, MicOff, Loader2, Check, BarChart3, Clock, Search, ChevronDown, ChevronRight, AlertTriangle, Trash2, X } from "lucide-react";
import { useDictationStore } from "@/stores/dictationStore";
import { useAppStore } from "@/stores/appStore";
import { formatDate, formatDateTime } from "@/lib/time";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { AnalyticsPanel } from "./dictation/AnalyticsPanel";
import {
  DEFAULT_PUSH_TO_TALK_SHORTCUT,
  DEFAULT_TOGGLE_SHORTCUT,
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
  const deleteEntry = useDictationStore((s) => s.deleteEntry);
  const clearHistory = useDictationStore((s) => s.clearHistory);
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
              <AnalyticsPanel analytics={analytics} />
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
              onDeleteEntry={deleteEntry}
              onClearHistory={clearHistory}
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

/* ── History Panel ── */

function HistoryPanel({
  history,
  searchQuery,
  onSearchChange,
  onSearch,
  onDeleteEntry,
  onClearHistory,
}: {
  history: DictationEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearch: () => void;
  onDeleteEntry: (id: number) => Promise<boolean>;
  onClearHistory: () => Promise<number | null>;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // Removal is confirmed through the shared `ConfirmDeleteModal` — the repo
  // fences `window.confirm` out of `src/` (scripts/confirm-idiom.test.mjs).
  const [pendingDelete, setPendingDelete] = useState<DictationEntry | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  // Subscribed so a change in Tools → Date & Time re-renders these timestamps.
  // `formatDate`/`formatDateTime` read the zone through `getState()`, which is
  // not reactive on its own.
  useAppStore((s) => s.timeZone);

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
        <button
          type="button"
          onClick={() => setConfirmingClear(true)}
          disabled={history.length === 0}
          className="px-3 py-1.5 text-[11px] text-accent-red hover:bg-accent-red/10 border border-bg-border rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-red disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Clear all
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
                {/* The expand control and the delete control are siblings, not
                    nested: a button inside a button is invalid HTML and the
                    inner click would also toggle the row. */}
                <div className="flex items-stretch">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="min-w-0 flex-1 flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green"
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
                      <span
                        className="text-[9px] text-text-muted"
                        title={formatDateTime(entry.timestamp)}
                      >
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(entry)}
                    aria-label={`Delete transcription: ${entry.text.slice(0, 40)}`}
                    className="shrink-0 px-3 text-text-muted transition-colors hover:bg-accent-red/10 hover:text-accent-red focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-red"
                  >
                    <Trash2 size={11} aria-hidden="true" />
                  </button>
                </div>
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

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete this transcription?"
          entityName={excerpt(pendingDelete.text)}
          description="is removed from the dictation history and from every analytics figure derived from it."
          confirmLabel="Delete"
          onConfirm={() => {
            const id = pendingDelete.id;
            setPendingDelete(null);
            void onDeleteEntry(id);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}

      {confirmingClear && (
        <ConfirmDeleteModal
          title="Clear all transcriptions?"
          description={`Deletes every transcription in the dictation history, along with the streaks, totals and word lists computed from them. ${history.length.toLocaleString()} ${history.length === 1 ? "is" : "are"} currently listed.`}
          warnings={["A search narrows the list, not the delete — the whole history goes."]}
          warningTitle="This clears everything, not just what is shown"
          confirmLabel="Clear all"
          onConfirm={() => {
            setConfirmingClear(false);
            void onClearHistory();
          }}
          onClose={() => setConfirmingClear(false)}
        />
      )}
    </div>
  );
}

/* ── Shared ── */

/** Name the transcript in the confirm dialog without pasting a paragraph into
 *  it. The user has to be able to see WHICH row they are about to lose. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
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

/** Entry timestamps are UTC-tagged ISO strings from `history.rs`, so parsing is
 *  unambiguous; only the *rendering* zone was wrong. This used to call
 *  `toLocaleDateString` with the browser's zone, which ignored Tools → Date &
 *  Time — the one card that claims to govern every date in the app. Away from
 *  the host zone that also broke the Analytics tab's UTC-bucketing note, whose
 *  "is this worth showing?" test is computed against the *configured* zone. */
function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 60_000) return "just now";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return formatDate(d) || ts;
  } catch {
    return ts;
  }
}
