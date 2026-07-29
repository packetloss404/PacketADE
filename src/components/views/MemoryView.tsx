import { useState, useMemo, useEffect } from "react";
import {
  Brain,
  Search,
  Trash2,
  Sparkles,
  RefreshCw,
  Clock,
  Star,
  Edit3,
  Check,
  X,
  Zap,
  Download,
  Upload,
  MessageSquare,
  Lightbulb,
  FileText,
} from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import {
  useMemoryStore,
  memoryBriefStats,
  searchMemoryEvents,
  filterMemoryEventsByScope,
  serializeMemoryExport,
  serializeMemoryMarkdown,
  computeContextItems,
  type MemoryDateRange,
  type ContextItem,
} from "@/stores/memoryStore";
import { computeMemoryDigest, type MemoryDigest } from "@/lib/memoryDigest";
import { useMemorySettingsStore } from "@/stores/memorySettingsStore";
import { useAppStore } from "@/stores/appStore";
import { MemoryEventCard } from "./memory/MemoryEventCard";
import { ProjectNotesTab } from "./memory/ProjectNotesTab";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";
import {
  unifiedMemoryResults,
  type MemorySourceFilter,
} from "@/lib/projectMemoryRetrieval";
import { TIMELINE_FILTERS, type FilterType } from "./memory/timelineFilters";
import type { MemoryEvent, MemoryEventType, PatternCategory, LearnedPattern } from "@/types/memory";
import { relativeTime } from "@/lib/time";

type Tab = "patterns" | "timeline" | "project" | "ask";

// M2: rolling date-window chips for the Timeline.
const DATE_RANGES: { key: MemoryDateRange; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

/** Last path segment of a project path, for a compact project chip label. */
function projectBasename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function ScopeChip({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`max-w-[140px] truncate rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
        active
          ? "border-accent-line bg-accent-soft font-semibold text-accent-green"
          : "border-transparent bg-transparent font-medium text-text-muted hover:text-text-secondary"
      }`}
    >
      {label}
    </button>
  );
}

const CATEGORY_ORDER: PatternCategory[] = ["architecture", "convention", "preference", "pitfall"];

const CATEGORY_META: Record<
  PatternCategory,
  { label: string; dot: string; bar: string; text: string }
> = {
  architecture: {
    label: "Architecture",
    dot: "bg-accent-blue",
    bar: "bg-accent-blue",
    text: "text-accent-blue",
  },
  convention: {
    label: "Convention",
    dot: "bg-accent-green",
    bar: "bg-accent-green",
    text: "text-accent-green",
  },
  preference: {
    label: "Preference",
    dot: "bg-accent-amber",
    bar: "bg-accent-amber",
    text: "text-accent-amber",
  },
  pitfall: {
    label: "Pitfall",
    dot: "bg-accent-red",
    bar: "bg-accent-red",
    text: "text-accent-red",
  },
};

function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function MemoryView() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const events = useMemoryStore((s) => s.events);
  const patterns = useMemoryStore((s) => s.patterns);
  const lastPatternRefreshAt = useMemoryStore((s) => s.lastPatternRefreshAt);
  const isLearning = useMemoryStore((s) => s.isLearning);
  const learningStatus = useMemoryStore((s) => s.learningStatus);
  const summariesSinceLastRefresh = useMemoryStore((s) => s.summariesSinceLastRefresh);
  const deleteEvent = useMemoryStore((s) => s.deleteEvent);
  const deletePattern = useMemoryStore((s) => s.deletePattern);
  const updatePattern = useMemoryStore((s) => s.updatePattern);
  const togglePinPattern = useMemoryStore((s) => s.togglePinPattern);
  const refreshPatterns = useMemoryStore((s) => s.refreshPatterns);
  const clearMemory = useMemoryStore((s) => s.clearMemory);
  const importMemory = useMemoryStore((s) => s.importMemory);
  const composeMemoryBrief = useMemoryStore((s) => s.composeMemoryBrief);
  const captureSessions = useMemorySettingsStore((s) => s.captureSessions);
  const captureFlights = useMemorySettingsStore((s) => s.captureFlights);
  const projectMemoryNotes = useProjectMemoryStore(
    (state) => state.snapshot.notes,
  );

  // v0.8-H — deep-link filter (e.g. from FlightsView's "N patterns
  // extracted" chip). Snapshot it on mount so subsequent re-renders
  // don't re-apply, and clear from the store so a back-and-forth
  // navigation resets cleanly.
  const incomingFilter = useAppStore((s) => s.memoryViewFilter);
  const clearMemoryViewFilter = useAppStore((s) => s.clearMemoryViewFilter);
  const [flightFilter, setFlightFilter] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>("patterns");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateRange, setDateRange] = useState<MemoryDateRange>("all");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  useEffect(() => {
    if (incomingFilter?.flightId) {
      setFlightFilter(incomingFilter.flightId);
      setActiveTab("timeline");
      clearMemoryViewFilter();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingFilter]);

  /** Predicate: does this event belong to the active flight filter? Only
   * `flight_completed` and `task_completed` carry a `flightId` payload. */
  const matchesFlightFilter = useMemo(() => {
    if (!flightFilter) return null;
    return (e: MemoryEvent): boolean => {
      if (e.type === "flight_completed") return e.payload.flightId === flightFilter;
      if (e.type === "task_completed") return e.payload.flightId === flightFilter;
      return false;
    };
  }, [flightFilter]);

  const summarizedCount = useMemo(
    () => events.filter((e) => e.type === "session_completed" && e.payload.summary !== null).length,
    [events],
  );

  const eventCounts = useMemo(() => {
    const counts: Record<FilterType, number> = {
      all: events.length,
      session_completed: 0,
      task_completed: 0,
      flight_completed: 0,
      manual_note: 0,
    };
    for (const e of events) counts[e.type]++;
    return counts;
  }, [events]);

  const filtered = useMemo(() => {
    let result = [...events].reverse();
    if (matchesFlightFilter) result = result.filter(matchesFlightFilter);
    if (filter !== "all") result = result.filter((e) => e.type === filter);
    result = filterMemoryEventsByScope(result, { project: projectFilter, dateRange });
    result = searchMemoryEvents(result, searchQuery);
    return result;
  }, [events, filter, searchQuery, matchesFlightFilter, projectFilter, dateRange]);

  const projects = useMemo(
    () => [...new Set(events.map((e) => e.projectPath).filter((p): p is string => Boolean(p)))].sort(),
    [events],
  );

  const groupedPatterns = useMemo(() => {
    const groups: Partial<Record<PatternCategory, LearnedPattern[]>> = {};
    for (const p of patterns) {
      (groups[p.category] ||= []).push(p);
    }
    for (const c of Object.keys(groups) as PatternCategory[]) {
      groups[c]!.sort((a, b) => b.confidence - a.confidence);
    }
    return groups;
  }, [patterns]);

  // M7: rolling 30-day digest. Recomputes only when the corpus changes; the
  // window anchors on render time (Date.now is fine in app code).
  const digest = useMemo(
    () => computeMemoryDigest(events, patterns, { now: Date.now() }),
    [events, patterns],
  );

  // P2-18 preview-truth: render the SAME budgeted brief the launch pipeline
  // injects (composeMemoryBrief) and derive the token estimate from
  // memoryBriefStats — the exact pair the header flyout uses. The legacy
  // getContextForSession preview + its `patterns.length * 32` token fallback
  // could show a nonzero "tok brief" for a scope whose brief is actually
  // empty; this keeps the preview from ever overstating what gets sent.
  // patterns/events are read inside composeMemoryBrief via the store's
  // get(); keep them in deps so the preview rebuilds when memory changes.
  const memoryBrief = useMemo(
    () => (projectPath ? composeMemoryBrief({ kind: "local", projectPath }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectPath, composeMemoryBrief, patterns, events],
  );

  const injectedPreview = memoryBrief?.text ?? "";
  const tokenEstimate = memoryBrief ? memoryBriefStats(memoryBrief).approxTokens : 0;
  const captureEnabled = captureSessions || captureFlights;

  function handleRefreshPatterns() {
    if (projectPath) void refreshPatterns(projectPath);
  }

  function handleClear() {
    if (window.confirm("Clear all memory? This removes all events and learned patterns.")) {
      clearMemory();
    }
  }

  // M3: download a Blob from the webview (no backend round-trip needed).
  function downloadBlob(filename: string, contents: string, mime: string) {
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportJson() {
    downloadBlob(
      "packetade-memory.json",
      serializeMemoryExport(events, patterns),
      "application/json",
    );
  }

  function handleExportMarkdown() {
    downloadBlob(
      "packetade-memory.md",
      serializeMemoryMarkdown(events, patterns),
      "text/markdown",
    );
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    void file.text().then((text) => {
      const result = importMemory(text);
      if (!result) {
        window.alert("Import failed: the file is not a valid PacketADE memory export.");
        return;
      }
      window.alert(
        `Imported ${result.addedEvents} new event(s) and ${result.addedPatterns} new pattern(s).`,
      );
    });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary">
      {/* Header band */}
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-bg-border bg-bg-secondary px-3.5 py-2.5">
        <Brain size={13} className="text-accent-green" />
        <span className="text-xs font-semibold text-text-primary">Memory</span>

        {isLearning && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent-green">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-green" />
            {learningStatus ?? "Learning..."}
          </span>
        )}

        <div className="flex-1" />

        <span className="text-[10.5px] text-text-faint">
          <span className="tabular-nums text-text-muted">{patterns.length}</span> patterns
          <span className="mx-1.5 text-line-strong">·</span>
          <span className="tabular-nums text-text-muted">{events.length}</span> events
          <span className="mx-1.5 text-line-strong">·</span>
          <span className="tabular-nums text-text-muted">
            {formatTokenCount(tokenEstimate)}
          </span>{" "}
          tok brief
        </span>

        <button
          onClick={handleRefreshPatterns}
          disabled={isLearning || !projectPath || summarizedCount === 0}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
          title="Refresh learned patterns"
        >
          <RefreshCw size={10} className={isLearning ? "animate-spin" : ""} />
          Refresh
        </button>
        {(events.length > 0 || patterns.length > 0) && (
          <>
            <button
              onClick={handleExportJson}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
              title="Export memory as JSON"
            >
              <Download size={10} />
              JSON
            </button>
            <button
              onClick={handleExportMarkdown}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
              title="Export memory as a Markdown digest"
            >
              <Download size={10} />
              MD
            </button>
          </>
        )}
        <label
          className="inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
          title="Import a JSON memory export (merges by id)"
        >
          <Upload size={10} />
          Import
          <input type="file" accept="application/json,.json" className="hidden" onChange={handleImportFile} />
        </label>
        {(events.length > 0 || patterns.length > 0) && (
          <button
            onClick={handleClear}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-elevated hover:text-accent-red"
            title="Clear all memory"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {/* Tab row */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-bg-border bg-bg-secondary px-2.5 py-1">
        <MemTab
          active={activeTab === "patterns"}
          onClick={() => setActiveTab("patterns")}
          icon={<Sparkles size={10} />}
          label="Patterns"
          badge={patterns.length}
          accent
        />
        <MemTab
          active={activeTab === "timeline"}
          onClick={() => setActiveTab("timeline")}
          icon={<Clock size={10} />}
          label="Events"
          badge={events.length}
        />
        <MemTab
          active={activeTab === "project"}
          onClick={() => setActiveTab("project")}
          icon={<FileText size={10} />}
          label="Project notes"
          badge={projectMemoryNotes.filter((note) => !note.metadata.archived).length}
        />
        <MemTab
          active={activeTab === "ask"}
          onClick={() => setActiveTab("ask")}
          icon={<MessageSquare size={10} />}
          label="Ask"
        />
        <div className="flex-1" />
        <span className="text-[10px] text-text-faint">
          {lastPatternRefreshAt ? (
            <>
              Last refresh{" "}
              <span className="font-mono text-text-muted">
                {relativeTime(lastPatternRefreshAt)}
              </span>
            </>
          ) : (
            <>Never refreshed</>
          )}
          <span className="mx-1.5 text-line-strong">·</span>
          <span className="tabular-nums text-text-muted">{summarizedCount}</span> summarized session
          {summarizedCount === 1 ? "" : "s"}
          {summariesSinceLastRefresh > 0 && (
            <>
              <span className="mx-1.5 text-line-strong">·</span>
              <span className="tabular-nums text-text-muted">+{summariesSinceLastRefresh}</span> new
            </>
          )}
        </span>
      </div>

      {flightFilter && (
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-accent-line bg-accent-soft px-3.5 py-1.5 text-[10.5px] text-accent-green">
          <Sparkles size={10} />
          <span>
            Filtered to flight <span className="font-mono">{flightFilter.slice(-6)}</span>
          </span>
          <span className="flex-1" />
          <button
            onClick={() => setFlightFilter(null)}
            className="hover:bg-accent-green/10 inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors"
            title="Clear flight filter"
          >
            <X size={9} />
            Clear
          </button>
        </div>
      )}

      {activeTab === "patterns" && (
        <PatternsTab
          groupedPatterns={groupedPatterns}
          patternCount={patterns.length}
          digest={digest}
          isLearning={isLearning}
          learningStatus={learningStatus}
          injectedPreview={injectedPreview}
          tokenEstimate={tokenEstimate}
          onDeletePattern={deletePattern}
          onUpdatePattern={updatePattern}
          onTogglePinPattern={togglePinPattern}
        />
      )}

      {activeTab === "timeline" && (
        <TimelineTab
          filter={filter}
          onFilterChange={setFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          counts={eventCounts}
          events={filtered}
          totalEvents={events.length}
          captureEnabled={captureEnabled}
          onDeleteEvent={deleteEvent}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          projectFilter={projectFilter}
          onProjectChange={setProjectFilter}
          projects={projects}
        />
      )}

      {activeTab === "project" && (
        <ProjectNotesTab projectPath={projectPath} globalEvents={events} />
      )}

      {activeTab === "ask" && (
        <AskTab
          events={events}
          patterns={patterns}
          projectPath={projectPath}
          projectNotes={projectMemoryNotes}
        />
      )}
    </div>
  );
}

interface MemTabProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  accent?: boolean;
}

function MemTab({ active, onClick, icon, label, badge, accent }: MemTabProps) {
  const activeText = accent ? "text-accent-green" : "text-text-primary";
  const activeBadge = accent
    ? "bg-accent-soft text-accent-green"
    : "bg-bg-elevated text-text-muted";
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? `${activeText} border border-line-strong bg-bg-elevated font-semibold`
          : "border border-transparent font-medium text-text-muted hover:text-text-secondary"
      }`}
    >
      {icon}
      {label}
      {badge != null && (
        <span
          className={`rounded-full px-1.5 text-[9px] tabular-nums ${
            active ? activeBadge : "bg-bg-elevated text-text-faint"
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

interface PatternsTabProps {
  groupedPatterns: Partial<Record<PatternCategory, LearnedPattern[]>>;
  patternCount: number;
  digest: MemoryDigest;
  isLearning: boolean;
  learningStatus: string | null;
  injectedPreview: string;
  tokenEstimate: number;
  onDeletePattern: (id: string) => void;
  onUpdatePattern: (id: string, updates: { pattern?: string; category?: PatternCategory }) => void;
  onTogglePinPattern: (id: string) => void;
}

// M7: rolling 30-day digest card in the Patterns right rail.
const DIGEST_TYPE_LABELS: Record<MemoryEventType, string> = {
  session_completed: "sessions",
  task_completed: "tasks",
  flight_completed: "flights",
  manual_note: "notes",
};

function MemoryDigestCard({ digest }: { digest: MemoryDigest }) {
  const typeRows = (Object.keys(digest.byType) as MemoryEventType[])
    .filter((t) => digest.byType[t] > 0)
    .map((t) => `${digest.byType[t]} ${DIGEST_TYPE_LABELS[t]}`);

  return (
    <div className="border-b border-bg-border px-3.5 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Clock size={10} className="text-accent-green" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
          Last {digest.windowDays} days
        </span>
      </div>
      {digest.isEmpty ? (
        <div className="text-[10.5px] text-text-faint">
          Nothing captured in this window yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[10.5px] text-text-secondary">
            <span>
              <span className="tabular-nums text-text-primary">{digest.eventCount}</span> event
              {digest.eventCount === 1 ? "" : "s"}
            </span>
            <span>
              <span className="tabular-nums text-text-primary">{digest.patternCount}</span> new
              pattern{digest.patternCount === 1 ? "" : "s"}
            </span>
          </div>
          {typeRows.length > 0 && (
            <div className="text-[10px] text-text-faint">{typeRows.join(" · ")}</div>
          )}
          {digest.topPatterns.length > 0 && (
            <div>
              <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                Top patterns
              </div>
              <ul className="flex flex-col gap-0.5">
                {digest.topPatterns.map((p) => (
                  <li key={p.id} className="flex items-baseline gap-1.5 text-[10px] leading-snug">
                    <span className="tabular-nums text-accent-green">
                      {Math.round(p.confidence * 100)}%
                    </span>
                    <span className="truncate text-text-secondary" title={p.pattern}>
                      {p.pattern}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {digest.recentLessons.length > 0 && (
            <div>
              <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-text-faint">
                Recent lessons
              </div>
              <ul className="flex flex-col gap-0.5">
                {digest.recentLessons.map((lesson, i) => (
                  <li key={i} className="truncate text-[10px] leading-snug text-text-secondary" title={lesson}>
                    • {lesson}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PatternsTab({
  groupedPatterns,
  patternCount,
  digest,
  isLearning,
  learningStatus,
  injectedPreview,
  tokenEstimate,
  onDeletePattern,
  onUpdatePattern,
  onTogglePinPattern,
}: PatternsTabProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[1fr_280px] overflow-hidden">
      {/* Left: pattern list */}
      <div className="overflow-y-auto px-3.5 py-3">
        {patternCount === 0 ? (
          <EmptyState
            icon={<Sparkles size={20} className="text-text-faint" />}
            title="No patterns yet"
            body="Open a session to start learning. Patterns are auto-extracted from session summaries."
          />
        ) : (
          CATEGORY_ORDER.filter((c) => groupedPatterns[c]?.length).map((cat) => {
            const meta = CATEGORY_META[cat];
            const list = groupedPatterns[cat]!;
            return (
              <div key={cat} className="mb-4 last:mb-0">
                <div className="mb-2 flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
                    {meta.label}
                  </span>
                  <span className="text-[10px] tabular-nums text-text-faint">{list.length}</span>
                  <div className="h-px flex-1 bg-bg-border" />
                </div>
                <div className="flex flex-col gap-1.5">
                  {list.map((p) => (
                    <PatternRow
                      key={p.id}
                      pattern={p}
                      meta={meta}
                      onDelete={() => onDeletePattern(p.id)}
                      onUpdate={(updates) => onUpdatePattern(p.id, updates)}
                      onTogglePin={() => onTogglePinPattern(p.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Right rail */}
      <div className="flex flex-col overflow-hidden border-l border-bg-border bg-bg-secondary">
        <MemoryDigestCard digest={digest} />
        {isLearning && (
          <div className="border-b border-bg-border px-3.5 py-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
              Extraction queue
            </div>
            <div className="flex items-center gap-2 py-1 text-[10.5px]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-green" />
              <span className="font-mono text-text-secondary">
                {learningStatus ?? "summarizing"}
              </span>
              <div className="flex-1" />
              <span className="text-text-faint">now</span>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3.5 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Brain size={10} className="text-accent-green" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-text-secondary">
              Memory brief
            </span>
          </div>
          <div className="mb-2 text-[10px] leading-relaxed text-text-faint">
            Compact source brief prepended to the system prompt when{" "}
            <span className="font-mono text-text-muted">memoryContextEnabled</span>.
          </div>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-bg-border bg-bg-primary p-2.5 font-mono text-[10px] leading-relaxed text-text-secondary">
            {injectedPreview.trim() ? (
              injectedPreview
            ) : (
              <span className="text-text-faint">
                # No memory brief will be injected yet.{"\n"}# Complete a few sessions to start
                learning.
              </span>
            )}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 rounded border border-accent-line bg-accent-soft px-2 py-1 text-[10px] text-accent-green">
            <Zap size={10} />~{formatTokenCount(tokenEstimate)} tok · compact brief · toggle
            per-conversation
          </div>
        </div>
      </div>
    </div>
  );
}

interface PatternRowProps {
  pattern: LearnedPattern;
  meta: (typeof CATEGORY_META)[PatternCategory];
  onDelete: () => void;
  onUpdate: (updates: { pattern?: string; category?: PatternCategory }) => void;
  onTogglePin: () => void;
}

function PatternRow({ pattern, meta, onDelete, onUpdate, onTogglePin }: PatternRowProps) {
  const pct = Math.round(pattern.confidence * 100);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pattern.pattern);
  const [draftCategory, setDraftCategory] = useState<PatternCategory>(pattern.category);

  const startEdit = () => {
    setDraft(pattern.pattern);
    setDraftCategory(pattern.category);
    setEditing(true);
  };

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onUpdate({
      pattern: trimmed,
      category: draftCategory !== pattern.category ? draftCategory : undefined,
    });
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="border-accent-blue/40 flex items-stretch gap-2.5 rounded-md border bg-bg-secondary p-2.5">
        <div className={`w-1 self-stretch rounded-full ${meta.bar}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
              if (e.key === "Escape") cancel();
            }}
            rows={2}
            autoFocus
            className="focus:border-accent-blue/60 w-full resize-y rounded border border-bg-border bg-bg-primary px-2 py-1 text-[11.5px] leading-snug text-text-primary focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={draftCategory}
              onChange={(e) => setDraftCategory(e.target.value as PatternCategory)}
              className="rounded border border-bg-border bg-bg-primary px-1 py-0.5 text-[10px] text-text-secondary"
              title="Category"
            >
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_META[c].label}
                </option>
              ))}
            </select>
            <span className="text-[9.5px] text-text-faint">Ctrl+Enter to save · Esc to cancel</span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <button
            onClick={save}
            className="hover:bg-accent-green/10 rounded p-1 text-accent-green"
            title="Save (Ctrl+Enter)"
          >
            <Check size={11} />
          </button>
          <button
            onClick={cancel}
            className="rounded p-1 text-text-faint hover:text-text-primary"
            title="Cancel (Esc)"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    );
  }

  const isPinned = pattern.pinned === true;
  return (
    <div
      className={`group flex items-stretch gap-2.5 rounded-md border bg-bg-secondary p-2.5 transition-colors ${
        isPinned
          ? "border-accent-green/40 hover:border-accent-green/60"
          : "border-bg-border hover:border-line-strong"
      }`}
    >
      <div className={`w-1 self-stretch rounded-full ${meta.bar}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5 text-[11.5px] leading-snug text-text-primary">
          {isPinned && (
            <Star
              size={10}
              className="mt-0.5 flex-shrink-0 fill-accent-green text-accent-green"
              aria-label="Pinned"
            />
          )}
          <span>{pattern.pattern}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <div className="h-[3px] w-16 overflow-hidden rounded-full bg-bg-elevated">
              <div className={`h-full ${meta.bar}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono text-[9.5px] tabular-nums text-text-faint">{pct}%</span>
          </div>
          <span className="text-[10px] text-text-faint">
            extracted {relativeTime(pattern.extractedAt)}
          </span>
          {pattern.projectPath && (
            <span
              className="max-w-[160px] truncate text-[10px] text-text-faint"
              title={pattern.projectPath}
            >
              · {pattern.projectPath.split(/[/\\]/).pop() || pattern.projectPath}
            </span>
          )}
        </div>
      </div>
      <div
        className={`flex flex-shrink-0 items-center gap-0.5 transition-opacity ${
          isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <button
          onClick={onTogglePin}
          className={`rounded p-1 transition-colors ${
            isPinned
              ? "hover:bg-accent-green/10 text-accent-green"
              : "text-text-faint hover:text-accent-green"
          }`}
          title={isPinned ? "Unpin (currently survives eviction)" : "Pin to top"}
          aria-pressed={isPinned}
        >
          <Star size={10} className={isPinned ? "fill-accent-green" : ""} />
        </button>
        <button
          onClick={startEdit}
          className="rounded p-1 text-text-faint hover:text-accent-blue"
          title="Edit pattern"
        >
          <Edit3 size={10} />
        </button>
        <button
          onClick={onDelete}
          className="rounded p-1 text-text-faint hover:text-accent-red"
          title="Delete pattern"
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}

interface TimelineTabProps {
  filter: FilterType;
  onFilterChange: (f: FilterType) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  counts: Record<FilterType, number>;
  events: ReturnType<typeof useMemoryStore.getState>["events"];
  totalEvents: number;
  captureEnabled: boolean;
  onDeleteEvent: (id: string) => void;
  dateRange: MemoryDateRange;
  onDateRangeChange: (r: MemoryDateRange) => void;
  projectFilter: string | null;
  onProjectChange: (p: string | null) => void;
  projects: string[];
}

function TimelineTab({
  filter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  counts,
  events,
  totalEvents,
  captureEnabled,
  onDeleteEvent,
  dateRange,
  onDateRangeChange,
  projectFilter,
  onProjectChange,
  projects,
}: TimelineTabProps) {
  return (
    <>
      {/* Filter row */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-bg-border bg-bg-secondary px-3.5 py-2">
        {TIMELINE_FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => onFilterChange(f.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] transition-colors ${
                active
                  ? "border-accent-line bg-accent-soft font-semibold text-accent-green"
                  : "border-transparent bg-transparent font-medium text-text-muted hover:text-text-secondary"
              }`}
            >
              {f.label}
              <span
                className={`font-mono text-[9px] tabular-nums ${
                  active ? "text-accent-green" : "text-text-faint"
                } opacity-85`}
              >
                {counts[f.key]}
              </span>
            </button>
          );
        })}
        <div className="flex-1" />
        <div className="flex min-w-[220px] items-center gap-1.5 rounded border border-bg-border bg-bg-primary px-2 py-0.5">
          <Search size={10} className="flex-shrink-0 text-text-faint" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search memory..."
            className="w-full bg-transparent text-[10.5px] text-text-primary placeholder:text-text-faint focus:outline-none"
          />
        </div>
      </div>

      {/* M2: date-range + project scope chips */}
      {(projects.length > 0 || dateRange !== "all" || projectFilter !== null) && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1 border-b border-bg-border bg-bg-secondary px-3.5 py-1.5">
          <span className="mr-0.5 text-[9px] uppercase tracking-wide text-text-faint">When</span>
          {DATE_RANGES.map((r) => (
            <ScopeChip
              key={r.key}
              active={dateRange === r.key}
              label={r.label}
              onClick={() => onDateRangeChange(r.key)}
            />
          ))}
          {projects.length > 0 && (
            <>
              <span className="ml-2 mr-0.5 text-[9px] uppercase tracking-wide text-text-faint">
                Project
              </span>
              <ScopeChip
                active={projectFilter === null}
                label="All"
                onClick={() => onProjectChange(null)}
              />
              {projects.map((p) => (
                <ScopeChip
                  key={p}
                  active={projectFilter === p}
                  label={projectBasename(p)}
                  title={p}
                  onClick={() => onProjectChange(p)}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Event list */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-3">
        {events.length === 0 ? (
          <EmptyState
            icon={<Brain size={20} className="text-text-faint" />}
            title={totalEvents === 0 ? "No events yet" : "No events match your filter"}
            body={
              totalEvents === 0
                ? captureEnabled
                  ? "Memory captures session, task, and flight completions automatically."
                  : "Memory capture is disabled in Settings."
                : "Try a different filter or clear your search."
            }
          />
        ) : (
          events.map((event) => (
            <MemoryEventCard
              key={event.id}
              event={event}
              onDelete={() => onDeleteEvent(event.id)}
            />
          ))
        )}
      </div>
    </>
  );
}

// M8: "Ask your project" — a keyword-ranked answer over the memory corpus.
// No LLM: reuses computeContextItems (the same query-aware ranker the launch
// pipeline uses) so results match what would actually be injected.
const ASK_ICON: Record<ContextItem["kind"], React.ReactNode> = {
  pattern: <Sparkles size={11} className="text-accent-green" />,
  lesson: <Lightbulb size={11} className="text-accent-amber" />,
  session: <FileText size={11} className="text-text-muted" />,
};

function AskTab({
  events,
  patterns,
  projectPath,
  projectNotes,
}: {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  projectPath: string | null;
  projectNotes: ReturnType<typeof useProjectMemoryStore.getState>["snapshot"]["notes"];
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [source, setSource] = useState<MemorySourceFilter>("all");

  const results = useMemo(() => {
    const q = submitted.trim();
    if (!q || !projectPath) return [];
    return unifiedMemoryResults(
      q,
      computeContextItems(
        events,
        patterns,
        { kind: "local", projectPath },
        q,
      ),
      projectNotes,
      { source },
    );
  }, [events, patterns, projectNotes, projectPath, source, submitted]);

  const submit = () => setSubmitted(query);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-bg-border bg-bg-secondary px-3.5 py-2.5">
        <MessageSquare size={12} className="text-accent-green" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Ask your project memory — e.g. how do we handle SSH auth?"
          className="focus:border-accent-green/50 flex-1 rounded border border-bg-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-muted"
        />
        <button
          onClick={submit}
          disabled={!query.trim() || !projectPath}
          className="rounded bg-accent-green/20 px-2.5 py-1.5 text-[11px] font-medium text-accent-green transition-colors hover:bg-accent-green/30 disabled:opacity-40"
        >
          Ask
        </button>
      </div>
      <div className="flex items-center gap-1 border-b border-bg-border bg-bg-secondary px-3.5 py-1.5">
        <span className="mr-1 text-[9px] uppercase tracking-wide text-text-faint">
          Source
        </span>
        {(["all", "global", "project"] as MemorySourceFilter[]).map((value) => (
          <ScopeChip
            key={value}
            active={source === value}
            label={
              value === "all"
                ? "All"
                : value === "global"
                  ? "PacketADE"
                  : "Project Markdown"
            }
            onClick={() => setSource(value)}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {!projectPath ? (
          <EmptyState
            icon={<MessageSquare size={20} className="text-text-faint" />}
            title="No project open"
            body="Open a workspace to ask its accumulated memory."
          />
        ) : !submitted.trim() ? (
          <EmptyState
            icon={<MessageSquare size={20} className="text-text-faint" />}
            title="Ask your project"
            body="Type a question to search learned patterns and flight lessons, ranked by relevance. No AI call — this is your own memory."
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Search size={20} className="text-text-faint" />}
            title="Nothing relevant found"
            body="No patterns or recent lessons matched that question for this project."
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="mb-1 text-[10px] text-text-faint">
              {results.length} result{results.length === 1 ? "" : "s"} for{" "}
              <span className="font-mono text-text-muted">“{submitted.trim()}”</span>
            </div>
            {results.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-2"
              >
                <span className="mt-px shrink-0">
                  {item.kind === "project_note" ? (
                    <FileText size={11} className="text-accent-blue" />
                  ) : (
                    ASK_ICON[item.kind]
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] leading-snug text-text-primary">{item.title}</div>
                  <div className="mt-0.5 text-[9.5px] text-text-faint">
                    {item.source} · {item.reason}
                    {item.provenanceIds.length > 0 &&
                      ` · ${item.provenanceIds.length} source ref`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  body: string;
}

function EmptyState({ icon, title, body }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="opacity-60">{icon}</div>
      <p className="text-[11px] text-text-secondary">{title}</p>
      <p className="max-w-[260px] text-[10px] leading-relaxed text-text-faint">{body}</p>
    </div>
  );
}
