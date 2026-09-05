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
  Plus,
  Folder,
  Server,
  ScanSearch,
} from "lucide-react";
import { useMemoryScope } from "@/hooks/useMemoryScope";
import { useMemoryProjectLabel } from "@/hooks/useMemoryProjectLabel";
import { scopeBasename } from "@/lib/memoryScope";
import type { MemoryProjectLabel } from "@/lib/memoryProjectLabel";
import {
  useMemoryStore,
  memoryBriefStats,
  memoryWriteKey,
  searchMemoryEvents,
  filterMemoryEventsByScope,
  findLegacyRemoteMemory,
  findAdoptedRemoteMemory,
  findCodebaseScanNote,
  serializeMemoryExport,
  serializeMemoryMarkdown,
  type MemoryBriefScope,
  type MemoryDateRange,
} from "@/stores/memoryStore";
import { computeMemoryDigest, type MemoryDigest } from "@/lib/memoryDigest";
import { useMemorySettingsStore } from "@/stores/memorySettingsStore";
import { useAppStore } from "@/stores/appStore";
import { MemoryEventCard } from "./memory/MemoryEventCard";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { ProjectNotesTab } from "./memory/ProjectNotesTab";
import { useProjectMemoryStore } from "@/stores/projectMemoryStore";
import {
  askMemory,
  memorySearchCountPhrase,
  MEMORY_SEARCH_KIND_LABEL,
  type MemorySearchKind,
  type MemorySourceFilter,
} from "@/lib/memorySearch";
import { TIMELINE_FILTERS, type FilterType } from "./memory/timelineFilters";
import type { MemoryEvent, MemoryEventType, PatternCategory, LearnedPattern } from "@/types/memory";
import { relativeTime } from "@/lib/time";
import { APP_NAME } from "@/lib/brand";

type Tab = "patterns" | "timeline" | "project" | "ask";

// M2: rolling date-window chips for the Timeline.
const DATE_RANGES: { key: MemoryDateRange; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

// The old `projectBasename` helper lived here. It assumed every stored
// `projectPath` was a filesystem path, so once remote capture started stamping
// `ssh:<serverId>:<path>` keys it would have rendered a raw scope key at the
// user. Scope display now goes through `useMemoryProjectLabel`, which resolves
// the server name ("build-box · app") and degrades to the bare id when the
// server is gone.

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
  // Derived from the ACTIVE WORKSPACE, not the local-only
  // `layoutStore.projectPath` mirror. On a remote workspace that mirror still
  // holds the last local project, which used to silently scope this whole pane
  // - and its writes - to a different project.
  const scope = useMemoryScope();
  // Only for things that touch THIS machine's filesystem. Null on remote, so a
  // local-FS Tauri command can never be handed a remote path.
  const projectPath = scope.kind === "local" ? scope.projectPath : null;
  const briefScope = scope.kind === "none" ? null : scope.briefScope;
  // The key everything in this scope is stored under. For a local scope this
  // is just the project path; for a remote one it is the `ssh:` scope key.
  const scopeKey = briefScope ? memoryWriteKey(briefScope) : null;
  const labelProject = useMemoryProjectLabel();
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
  const scanCodebase = useMemoryStore((s) => s.scanCodebase);
  const clearMemory = useMemoryStore((s) => s.clearMemory);
  const importMemory = useMemoryStore((s) => s.importMemory);
  const composeMemoryBrief = useMemoryStore((s) => s.composeMemoryBrief);
  const adoptLegacyRemoteMemory = useMemoryStore((s) => s.adoptLegacyRemoteMemory);
  const revertAdoptedRemoteMemory = useMemoryStore((s) => s.revertAdoptedRemoteMemory);
  const captureSessions = useMemorySettingsStore((s) => s.captureSessions);
  const captureFlights = useMemorySettingsStore((s) => s.captureFlights);
  const [pendingDelete, setPendingDelete] = useState<PendingMemoryDelete | null>(null);
  const projectMemoryNotes = useProjectMemoryStore(
    (state) => state.snapshot.notes,
  );
  const loadProjectMemory = useProjectMemoryStore((state) => state.load);
  const captureManually = useMemoryStore((s) => s.captureManually);

  // Hydrate project notes whenever the Memory view is open for a project.
  // Previously the only loader was the Project-notes tab's own mount effect, so
  // the tab badge read 0 and the Ask tab's "Project Markdown" source returned
  // nothing until the user happened to click into that one tab.
  useEffect(() => {
    if (!projectPath) return;
    void loadProjectMemory(projectPath);
  }, [projectPath, loadProjectMemory]);

  // v0.8-H — deep-link filter (e.g. from FlightsView's "N patterns
  // extracted" chip). Snapshot it on mount so subsequent re-renders
  // don't re-apply, and clear from the store so a back-and-forth
  // navigation resets cleanly.
  const incomingFilter = useAppStore((s) => s.memoryViewFilter);
  const clearMemoryViewFilter = useAppStore((s) => s.clearMemoryViewFilter);
  const [flightFilter, setFlightFilter] = useState<string | null>(null);

  // Patterns require a configured aux LLM; the timeline never does. Landing on
  // an empty Patterns tab was the first thing a user saw, which is a large part
  // of why the pane read as broken.
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    useMemoryStore.getState().patterns.length > 0 ? "patterns" : "timeline",
  );
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

  // Scoped to the active project, because `refreshPatterns` filters by project.
  // A global count enabled the button for projects with nothing to extract.
  const refreshableCount = useMemo(() => {
    if (!scopeKey) return 0;
    const norm = (p: string) => p.split("\\").join("/").toLowerCase();
    const target = norm(scopeKey);
    return events.filter(
      (e) =>
        norm(e.projectPath) === target &&
        (e.type === "manual_note" ||
          e.type === "flight_completed" ||
          (e.type === "session_completed" && e.payload.summary !== null)),
    ).length;
  }, [events, scopeKey]);

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
    () => (briefScope ? composeMemoryBrief(briefScope) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [briefScope, composeMemoryBrief, patterns, events],
  );

  // Memory recorded under the plain remote path before remote scoping existed
  // (adoptable), and memory already adopted into this scope (revertible).
  const { adoptableCount, adoptedCount } = useMemo(() => {
    if (!briefScope || scope.kind !== "ssh") return { adoptableCount: 0, adoptedCount: 0 };
    const legacy = findLegacyRemoteMemory(events, patterns, briefScope);
    const adopted = findAdoptedRemoteMemory(events, patterns, briefScope);
    return {
      adoptableCount: legacy.eventIds.length + legacy.patternIds.length,
      adoptedCount: adopted.eventIds.length + adopted.patternIds.length,
    };
  }, [events, patterns, briefScope, scope.kind]);

  // A scan already recorded for this scope. Its presence changes the button
  // from "Scan" to "Re-scan", because a second run REPLACES this note rather
  // than adding another one, and the user should know that before clicking.
  const priorScan = useMemo(
    () => (briefScope ? findCodebaseScanNote(events, briefScope) : null),
    [events, briefScope],
  );

  const injectedPreview = memoryBrief?.text ?? "";
  const tokenEstimate = memoryBrief ? memoryBriefStats(memoryBrief).approxTokens : 0;
  const captureEnabled = captureSessions || captureFlights;

  function handleRefreshPatterns() {
    if (briefScope) void refreshPatterns(briefScope);
  }

  /** Index this project's key files into memory. Local-only: the walk reads
   *  this machine's filesystem, which is why the button is gated on
   *  `projectPath` (null under a remote scope) rather than on `briefScope`. */
  function handleScanCodebase() {
    if (!projectPath) return;
    void scanCodebase(projectPath).then((wrote) => {
      // The scan lands as a note in the Timeline; go where it landed. On
      // failure the header status chip already says what went wrong, and
      // yanking the user to an unchanged tab would only confuse that.
      if (wrote) setActiveTab("timeline");
    });
  }

  function handleAdoptLegacy() {
    if (!briefScope || scope.kind !== "ssh") return;
    const moved = adoptLegacyRemoteMemory(briefScope);
    if (moved > 0) setActiveTab("timeline");
  }

  function handleRevertAdopted() {
    if (!briefScope || scope.kind !== "ssh") return;
    revertAdoptedRemoteMemory(briefScope);
  }

  // Confirm-gating for the three destructive memory actions. Before this the
  // irreversible ones (per-pattern, per-event) fired instantly from a 9-10px
  // hover trash icon while only clear-all asked — via `window.confirm`.
  function confirmPendingDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "all") clearMemory();
    else if (pendingDelete.kind === "pattern") deletePattern(pendingDelete.id);
    else deleteEvent(pendingDelete.id);
    setPendingDelete(null);
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
      "packetbench-memory.json",
      serializeMemoryExport(events, patterns),
      "application/json",
    );
  }

  function handleExportMarkdown() {
    downloadBlob(
      "packetbench-memory.md",
      serializeMemoryMarkdown(events, patterns, {
        labelScope: (key) => labelProject(key).title,
      }),
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
        window.alert(`Import failed: the file is not a valid ${APP_NAME} memory export.`);
        return;
      }
      window.alert(
        `Imported ${result.addedEvents} new event(s) and ${result.addedPatterns} new pattern(s).`,
      );
    });
  }

  /** Manual capture straight from the Memory pane. The pane previously had no
   *  way at all to put something into memory - every capture affordance lived
   *  on some other surface. */
  function handleAddNote() {
    // Scoped, not path-gated: a remote workspace can save a note too, and it
    // lands under that workspace's `ssh:` key rather than a bare path.
    if (!briefScope) return;
    const summary = window.prompt(`What should ${APP_NAME} remember?`);
    if (!summary?.trim()) return;
    const body = window.prompt("Any detail to go with it? (optional)") ?? "";
    captureManually({
      scope: briefScope,
      source: "manual",
      summary: summary.trim(),
      body: body.trim() || summary.trim(),
      tags: ["manual"],
    });
    setActiveTab("timeline");
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary">
      {/* Header band */}
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-bg-border bg-bg-secondary px-3.5 py-2.5">
        <Brain size={13} className="text-accent-green" />
        <span className="text-xs font-semibold text-text-primary">Memory</span>

        <span
          title={
            scope.kind === "ssh"
              ? `Remote workspace on ${scope.serverName} — memory scoped to ${scope.remotePath}`
              : scope.kind === "local"
                ? `Memory scoped to ${scope.projectPath}`
                : "Open a workspace to scope memory"
          }
          className={`inline-flex max-w-[200px] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[10px] ${
            scope.kind === "ssh"
              ? "border-accent-amber/40 bg-bg-elevated text-accent-amber"
              : "border-bg-border bg-bg-elevated text-text-muted"
          }`}
        >
          {scope.kind === "ssh" ? <Server size={9} /> : <Folder size={9} />}
          <span className="truncate">
            {scope.kind === "ssh"
              ? `${scope.serverName} · ${scopeBasename(scope.remotePath)}`
              : scope.kind === "local"
                ? scopeBasename(scope.projectPath)
                : "No project"}
          </span>
        </span>

        {isLearning ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent-green">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-green" />
            {learningStatus ?? "Learning..."}
          </span>
        ) : learningStatus ? (
          // Not learning but a status remains: the last attempt failed or found
          // nothing. Say so. This used to be swallowed into a console.warn,
          // which is what made Refresh feel like a dead button.
          <span
            title={learningStatus}
            className="inline-flex max-w-[420px] items-center gap-1.5 truncate rounded-full border border-bg-border bg-bg-elevated px-2 py-0.5 text-[10px] font-medium text-text-muted"
          >
            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-amber" />
            <span className="truncate">{learningStatus}</span>
          </span>
        ) : null}

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
          onClick={handleAddNote}
          disabled={!briefScope}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
          title={
            !briefScope
              ? "Open a workspace to add a memory"
              : scope.kind === "ssh"
                ? `Save a note to ${scope.serverName}'s memory for ${scope.remotePath}`
                : "Save a note to memory"
          }
        >
          <Plus size={10} />
          New memory
        </button>

        <button
          onClick={handleRefreshPatterns}
          disabled={isLearning || !briefScope || refreshableCount === 0}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
          title={
            !briefScope
              ? "Open a workspace to extract patterns"
              : refreshableCount === 0
                ? "Nothing to extract from yet in this workspace"
                : `Extract patterns from ${refreshableCount} memories in this workspace`
          }
        >
          <RefreshCw size={10} className={isLearning ? "animate-spin" : ""} />
          Refresh
        </button>

        {/* Secondary to browsing and Ask: same quiet header treatment as
            Refresh, and it never becomes the pane's loudest control. */}
        <button
          onClick={handleScanCodebase}
          disabled={isLearning || !projectPath}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
          title={
            scope.kind === "ssh"
              ? "Codebase scan reads this machine's files, so it is local-workspace only"
              : !projectPath
                ? "Open a local workspace to index its codebase"
                : priorScan
                  ? "Re-index this project's key files — replaces the existing codebase index note"
                  : "Index this project's key files into memory. Needs a provider for the 'Codebase scan' task in Settings > Task Role Defaults."
          }
        >
          <ScanSearch size={10} />
          {priorScan ? "Re-scan codebase" : "Scan codebase"}
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
            onClick={() => setPendingDelete({ kind: "all" })}
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
          <span className="tabular-nums text-text-muted">{refreshableCount}</span> memor
          {refreshableCount === 1 ? "y" : "ies"} in this project
          {summariesSinceLastRefresh > 0 && (
            <>
              <span className="mx-1.5 text-line-strong">·</span>
              <span className="tabular-nums text-text-muted">+{summariesSinceLastRefresh}</span> new
            </>
          )}
        </span>
      </div>

      {/* The old banner here said remote workspaces record no memory. They do
          now, so the only remote-specific notice left is the one about memory
          recorded BEFORE remote scoping existed. */}
      {scope.kind === "ssh" && (adoptableCount > 0 || adoptedCount > 0) && (
        <div className="border-accent-amber/40 flex flex-shrink-0 items-start gap-1.5 border-b bg-bg-elevated px-3.5 py-1.5 text-[10.5px] text-accent-amber">
          <Server size={10} className="mt-0.5 shrink-0" />
          {adoptableCount > 0 ? (
            <span>
              <span className="font-semibold">
                {adoptableCount} older {adoptableCount === 1 ? "memory" : "memories"} recorded
                under the plain path <span className="font-mono">{scope.remotePath}</span>.
              </span>{" "}
              They were saved before memory was scoped per server, so nothing links them to{" "}
              {scope.serverName}. Adopt them only if they really came from this workspace — a
              local project at the same path would look identical. You can undo it.
              <button
                onClick={handleAdoptLegacy}
                className="ml-1.5 rounded border border-accent-amber/50 px-1.5 py-0.5 font-medium transition-colors hover:bg-accent-amber/10"
              >
                Adopt into {scope.serverName}
              </button>
            </span>
          ) : (
            <span>
              <span className="font-semibold">
                {adoptedCount} adopted {adoptedCount === 1 ? "memory" : "memories"}.
              </span>{" "}
              Records moved here from the plain path <span className="font-mono">
                {scope.remotePath}
              </span>. Undo puts them back exactly where they were.
              <button
                onClick={handleRevertAdopted}
                className="ml-1.5 rounded border border-accent-amber/50 px-1.5 py-0.5 font-medium transition-colors hover:bg-accent-amber/10"
              >
                Undo
              </button>
            </span>
          )}
        </div>
      )}

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
          patternSourceCount={refreshableCount}
          digest={digest}
          isLearning={isLearning}
          learningStatus={learningStatus}
          injectedPreview={injectedPreview}
          tokenEstimate={tokenEstimate}
          onDeletePattern={(id) =>
            setPendingDelete({
              kind: "pattern",
              id,
              label: patterns.find((p) => p.id === id)?.pattern ?? id,
            })
          }
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
          onDeleteEvent={(id) =>
            setPendingDelete({
              kind: "event",
              id,
              label: memoryEventLabel(events.find((e) => e.id === id)) ?? id,
            })
          }
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          projectFilter={projectFilter}
          onProjectChange={setProjectFilter}
          projects={projects}
          labelProject={labelProject}
          onAddNote={briefScope ? handleAddNote : undefined}
        />
      )}

      {activeTab === "project" && (
        <ProjectNotesTab
          projectPath={projectPath}
          globalEvents={events}
          remote={
            scope.kind === "ssh"
              ? { serverName: scope.serverName, remotePath: scope.remotePath }
              : undefined
          }
        />
      )}

      {activeTab === "ask" && (
        <AskTab
          events={events}
          patterns={patterns}
          scope={briefScope}
          projectNotes={projectMemoryNotes}
          onAddNote={briefScope ? handleAddNote : undefined}
        />
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title={
            pendingDelete.kind === "all"
              ? "Clear all memory?"
              : pendingDelete.kind === "pattern"
                ? "Delete learned pattern?"
                : "Delete memory event?"
          }
          entityName={pendingDelete.kind === "all" ? undefined : truncateLabel(pendingDelete.label)}
          description={
            pendingDelete.kind === "all"
              ? "Every captured event and learned pattern is removed. Export first if you want a copy."
              : pendingDelete.kind === "pattern"
                ? "stops being injected into future agent sessions."
                : "is removed from the timeline and from any brief built from it."
          }
          confirmLabel={pendingDelete.kind === "all" ? "Clear memory" : "Delete"}
          onConfirm={confirmPendingDelete}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

type PendingMemoryDelete =
  | { kind: "all" }
  | { kind: "pattern"; id: string; label: string }
  | { kind: "event"; id: string; label: string };

function memoryEventLabel(event: MemoryEvent | undefined): string | null {
  if (!event) return null;
  const kind = event.type.replace(/_/g, " ");
  const summary = typeof event.payload.summary === "string" ? event.payload.summary : "";
  return summary ? `${kind} — ${summary}` : kind;
}

function truncateLabel(label: string): string {
  return label.length > 90 ? `${label.slice(0, 90)}…` : label;
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
  /** Memories in this project that Refresh could distill patterns from. */
  patternSourceCount: number;
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
  patternSourceCount,
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
            body={
              patternSourceCount === 0
                ? "Patterns are distilled from what memory has already recorded. Record a session or save a note first, then come back and hit Refresh."
                : `Refresh will distill patterns from the ${patternSourceCount} memor${patternSourceCount === 1 ? "y" : "ies"} in this project. This needs an aux LLM provider configured in Settings > API Keys.`
            }
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
  const labelProject = useMemoryProjectLabel();
  const scopeLabel = pattern.projectPath ? labelProject(pattern.projectPath) : null;
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
          {scopeLabel && (
            <span
              className={`max-w-[180px] truncate text-[10px] ${
                scopeLabel.kind === "ssh" ? "text-accent-amber" : "text-text-faint"
              }`}
              title={scopeLabel.title}
            >
              · {scopeLabel.label}
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
  /** Resolves a stored scope key to display text — never show the raw key. */
  labelProject: (key: string) => MemoryProjectLabel;
  onAddNote?: () => void;
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
  labelProject,
  onAddNote,
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
              {projects.map((p) => {
                // The chip's VALUE stays the raw stored key (that is what
                // `filterMemoryEventsByScope` matches on); only the text is
                // resolved.
                const resolved = labelProject(p);
                return (
                  <ScopeChip
                    key={p}
                    active={projectFilter === p}
                    label={resolved.label}
                    title={resolved.title}
                    onClick={() => onProjectChange(p)}
                  />
                );
              })}
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
                  ? "Terminal sessions longer than 10 seconds and finished flights are recorded here automatically. You can also save anything yourself with New memory."
                  : "Memory capture is disabled in Settings > Memory, so nothing is being recorded. You can still save notes yourself with New memory."
                : "Try a different filter or clear your search."
            }
            action={
              totalEvents === 0 && onAddNote ? (
                <button
                  onClick={onAddNote}
                  className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                >
                  <Plus size={10} />
                  Add your first memory
                </button>
              ) : null
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
const ASK_ICON: Record<MemorySearchKind, React.ReactNode> = {
  pattern: <Sparkles size={11} className="text-accent-green" />,
  lesson: <Lightbulb size={11} className="text-accent-amber" />,
  flight: <Lightbulb size={11} className="text-accent-amber" />,
  session: <FileText size={11} className="text-text-muted" />,
  manual_note: <Edit3 size={11} className="text-text-secondary" />,
  task: <FileText size={11} className="text-text-faint" />,
  project_note: <FileText size={11} className="text-accent-blue" />,
};
function AskTab({
  events,
  patterns,
  scope,
  projectNotes,
  onAddNote,
}: {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  /** The active memory scope — local or ssh. Null when no workspace is open. */
  scope: MemoryBriefScope | null;
  projectNotes: ReturnType<typeof useProjectMemoryStore.getState>["snapshot"]["notes"];
  onAddNote?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [source, setSource] = useState<MemorySourceFilter>("all");
  const [includeAllProjects, setIncludeAllProjects] = useState(false);

  const outcome = useMemo(() => {
    const q = submitted.trim();
    if (!q || !scope) return null;
    // Searches the whole corpus, not the prompt-injection budget: no
    // confidence gate, no per-source cap, no 48h/7d recency windows. Scope
    // matching is shared with the injection path, so an ssh scope still only
    // sees memory keyed to that server + remote path.
    return askMemory(q, events, patterns, projectNotes, scope, {
      source,
      includeAllProjects,
    });
  }, [events, patterns, projectNotes, scope, source, submitted, includeAllProjects]);

  const submit = () => setSubmitted(query);
  const results = outcome?.results ?? [];
  const searched = outcome ? memorySearchCountPhrase(outcome.counts) : "nothing";

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
          disabled={!query.trim() || !scope}
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
                  ? APP_NAME
                  : "Project Markdown"
            }
            onClick={() => setSource(value)}
          />
        ))}
        <span className="mx-1 text-line-strong">·</span>
        <ScopeChip
          active={includeAllProjects}
          label="All projects"
          title="Search memory recorded in other projects too"
          onClick={() => setIncludeAllProjects((v) => !v)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {!scope ? (
          <EmptyState
            icon={<MessageSquare size={20} className="text-text-faint" />}
            title="No project open"
            body="Open a workspace to ask its accumulated memory."
          />
        ) : !submitted.trim() ? (
          <EmptyState
            icon={<MessageSquare size={20} className="text-text-faint" />}
            title="Ask your project"
            body="Searches every learned pattern, recorded event and project note — the whole corpus, not just what gets injected into prompts. Keyword ranked, no AI call."
          />
        ) : results.length === 0 ? (
          outcome && outcome.counts.entries === 0 ? (
            <EmptyState
              icon={<Search size={20} className="text-text-faint" />}
              title="Nothing to search yet"
              body="This project has no learned patterns, recorded events or project notes yet. Finish a terminal session, or add something with New memory."
              action={
                onAddNote ? (
                  <button
                    onClick={onAddNote}
                    className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                  >
                    <Plus size={10} />
                    Add your first memory
                  </button>
                ) : null
              }
            />
          ) : (
            <EmptyState
              icon={<Search size={20} className="text-text-faint" />}
              title="No memory matched that"
              body={`Searched ${searched} in this project and found nothing containing those words. Try fewer or more distinctive words.`}
              action={
                !includeAllProjects ? (
                  <button
                    onClick={() => setIncludeAllProjects(true)}
                    className="inline-flex items-center gap-1 rounded border border-bg-border px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
                  >
                    Search all projects
                  </button>
                ) : null
              }
            />
          )
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="mb-1 text-[10px] text-text-faint">
              {outcome?.truncated
                ? `Top ${results.length} of ${outcome.totalMatches} matches for `
                : `${results.length} result${results.length === 1 ? "" : "s"} for `}
              <span className="font-mono text-text-muted">“{submitted.trim()}”</span>
              {" · searched "}
              {searched}
            </div>
            {results.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-2"
              >
                <span className="mt-px shrink-0">{ASK_ICON[item.kind]}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] leading-snug text-text-primary">{item.title}</div>
                  {item.detail ? (
                    <div className="mt-0.5 truncate text-[10px] text-text-muted">{item.detail}</div>
                  ) : null}
                  <div className="mt-0.5 text-[9.5px] text-text-faint">
                    {MEMORY_SEARCH_KIND_LABEL[item.kind]} · {relativeTime(item.timestamp)}
                    {item.matchedTerms.length > 0 && ` · matched ${item.matchedTerms.join(", ")}`}
                    {item.provenanceIds.length > 0 &&
                      ` · ${item.provenanceIds.length} source ref${
                        item.provenanceIds.length === 1 ? "" : "s"
                      }`}
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
  /** Optional next step. An empty state without one just tells the user they
   *  have nothing; with one it tells them how to get something. */
  action?: React.ReactNode;
}

function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="opacity-60">{icon}</div>
      <p className="text-[11px] text-text-secondary">{title}</p>
      <p className="max-w-[280px] text-[10px] leading-relaxed text-text-faint">{body}</p>
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
