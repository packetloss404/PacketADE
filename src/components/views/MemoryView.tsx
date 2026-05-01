import { useState, useMemo } from "react";
import {
  Brain,
  Search,
  Trash2,
  Sparkles,
  RefreshCw,
  Clock,
  Star,
  Edit3,
  Zap,
} from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { MemoryEventCard } from "./memory/MemoryEventCard";
import type {
  MemoryEventType,
  PatternCategory,
  LearnedPattern,
} from "@/types/memory";
import { relativeTime } from "@/lib/time";

type Tab = "patterns" | "timeline";
type FilterType = "all" | MemoryEventType;

const FILTERS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "session_completed", label: "Sessions" },
  { key: "task_completed", label: "Tasks" },
  { key: "flight_completed", label: "Flights" },
];

const CATEGORY_ORDER: PatternCategory[] = [
  "architecture",
  "convention",
  "preference",
  "pitfall",
];

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
  const summariesSinceLastRefresh = useMemoryStore(
    (s) => s.summariesSinceLastRefresh,
  );
  const deleteEvent = useMemoryStore((s) => s.deleteEvent);
  const deletePattern = useMemoryStore((s) => s.deletePattern);
  const refreshPatterns = useMemoryStore((s) => s.refreshPatterns);
  const clearMemory = useMemoryStore((s) => s.clearMemory);
  const getContextForSession = useMemoryStore((s) => s.getContextForSession);

  const [activeTab, setActiveTab] = useState<Tab>("patterns");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const summarizedCount = useMemo(
    () =>
      events.filter(
        (e) => e.type === "session_completed" && e.payload.summary !== null,
      ).length,
    [events],
  );

  const eventCounts = useMemo(() => {
    const counts: Record<FilterType, number> = {
      all: events.length,
      session_completed: 0,
      task_completed: 0,
      flight_completed: 0,
    };
    for (const e of events) counts[e.type]++;
    return counts;
  }, [events]);

  const filtered = useMemo(() => {
    let result = [...events].reverse();
    if (filter !== "all") result = result.filter((e) => e.type === filter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((e) =>
        JSON.stringify(e.payload).toLowerCase().includes(q),
      );
    }
    return result;
  }, [events, filter, searchQuery]);

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

  // patterns/events are read inside getContextForSession; keep them in deps
  // so the preview rebuilds when memory changes.
  const injectedPreview = useMemo(
    () => (projectPath ? getContextForSession(projectPath) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectPath, getContextForSession, patterns, events],
  );

  const tokenEstimate = Math.round(
    (injectedPreview.length || patterns.length * 32) / 4,
  );

  function handleRefreshPatterns() {
    if (projectPath) void refreshPatterns(projectPath);
  }

  function handleClear() {
    if (
      window.confirm(
        "Clear all memory? This removes all events and learned patterns.",
      )
    ) {
      clearMemory();
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* Header band */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-secondary border-b border-bg-border flex-shrink-0">
        <Brain size={13} className="text-accent-green" />
        <span className="text-xs font-semibold text-text-primary">Memory</span>

        {isLearning && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent-soft border border-accent-line text-[10px] font-medium text-accent-green">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
            {learningStatus ?? "Learning..."}
          </span>
        )}

        <div className="flex-1" />

        <span className="text-[10.5px] text-text-faint">
          <span className="text-text-muted tabular-nums">
            {patterns.length}
          </span>{" "}
          patterns
          <span className="mx-1.5 text-line-strong">·</span>
          <span className="text-text-muted tabular-nums">{events.length}</span>{" "}
          events
          <span className="mx-1.5 text-line-strong">·</span>
          <span className="text-text-muted tabular-nums">
            {formatTokenCount(tokenEstimate)}
          </span>{" "}
          tok stored
        </span>

        <button
          onClick={handleRefreshPatterns}
          disabled={
            isLearning || !projectPath || summarizedCount === 0
          }
          className="inline-flex items-center gap-1 px-2 py-1 text-[10.5px] text-text-secondary hover:text-text-primary hover:bg-bg-elevated rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          title="Refresh learned patterns"
        >
          <RefreshCw size={10} className={isLearning ? "animate-spin" : ""} />
          Refresh
        </button>
        {(events.length > 0 || patterns.length > 0) && (
          <button
            onClick={handleClear}
            className="p-1 text-text-muted hover:text-accent-red hover:bg-bg-elevated rounded transition-colors"
            title="Clear all memory"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {/* Tab row */}
      <div className="flex items-center gap-1 px-2.5 py-1 bg-bg-secondary border-b border-bg-border flex-shrink-0">
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
          <span className="text-text-muted tabular-nums">
            {summarizedCount}
          </span>{" "}
          summarized session{summarizedCount === 1 ? "" : "s"}
          {summariesSinceLastRefresh > 0 && (
            <>
              <span className="mx-1.5 text-line-strong">·</span>
              <span className="text-text-muted tabular-nums">
                +{summariesSinceLastRefresh}
              </span>{" "}
              new
            </>
          )}
        </span>
      </div>

      {activeTab === "patterns" && (
        <PatternsTab
          groupedPatterns={groupedPatterns}
          patternCount={patterns.length}
          isLearning={isLearning}
          learningStatus={learningStatus}
          injectedPreview={injectedPreview}
          tokenEstimate={tokenEstimate}
          onDeletePattern={deletePattern}
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
          onDeleteEvent={deleteEvent}
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
  badge: number;
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
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded transition-colors ${
        active
          ? `${activeText} font-semibold bg-bg-elevated border border-line-strong`
          : "text-text-muted font-medium hover:text-text-secondary border border-transparent"
      }`}
    >
      {icon}
      {label}
      {badge != null && (
        <span
          className={`text-[9px] px-1.5 rounded-full tabular-nums ${
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
  isLearning: boolean;
  learningStatus: string | null;
  injectedPreview: string;
  tokenEstimate: number;
  onDeletePattern: (id: string) => void;
}

function PatternsTab({
  groupedPatterns,
  patternCount,
  isLearning,
  learningStatus,
  injectedPreview,
  tokenEstimate,
  onDeletePattern,
}: PatternsTabProps) {
  return (
    <div className="flex-1 grid grid-cols-[1fr_280px] min-h-0 overflow-hidden">
      {/* Left: pattern list */}
      <div className="overflow-y-auto px-3.5 py-3">
        {patternCount === 0 ? (
          <EmptyState
            icon={<Sparkles size={20} className="text-text-faint" />}
            title="No patterns yet"
            body="Open a session to start learning. Patterns are auto-extracted from session summaries."
          />
        ) : (
          CATEGORY_ORDER.filter((c) => groupedPatterns[c]?.length).map(
            (cat) => {
              const meta = CATEGORY_META[cat];
              const list = groupedPatterns[cat]!;
              return (
                <div key={cat} className="mb-4 last:mb-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${meta.dot}`}
                    />
                    <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-text-secondary">
                      {meta.label}
                    </span>
                    <span className="text-[10px] text-text-faint tabular-nums">
                      {list.length}
                    </span>
                    <div className="flex-1 h-px bg-bg-border" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {list.map((p) => (
                      <PatternRow
                        key={p.id}
                        pattern={p}
                        meta={meta}
                        onDelete={() => onDeletePattern(p.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            },
          )
        )}
      </div>

      {/* Right rail */}
      <div className="border-l border-bg-border bg-bg-secondary flex flex-col overflow-hidden">
        {isLearning && (
          <div className="px-3.5 py-3 border-b border-bg-border">
            <div className="text-[10px] font-semibold tracking-[0.06em] uppercase text-text-secondary mb-2">
              Extraction queue
            </div>
            <div className="flex items-center gap-2 py-1 text-[10.5px]">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
              <span className="font-mono text-text-secondary">
                {learningStatus ?? "summarizing"}
              </span>
              <div className="flex-1" />
              <span className="text-text-faint">now</span>
            </div>
          </div>
        )}

        <div className="px-3.5 py-3 flex-1 overflow-y-auto">
          <div className="flex items-center gap-1.5 mb-2">
            <Brain size={10} className="text-accent-green" />
            <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-text-secondary">
              Injected next session
            </span>
          </div>
          <div className="text-[10px] text-text-faint leading-relaxed mb-2">
            Top patterns prepended to system prompt when{" "}
            <span className="font-mono text-text-muted">
              memoryContextEnabled
            </span>
            .
          </div>
          <div className="bg-bg-primary border border-bg-border rounded-md p-2.5 font-mono text-[10px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
            {injectedPreview.trim() ? (
              injectedPreview
            ) : (
              <span className="text-text-faint">
                # No context will be injected yet.{"\n"}# Complete a few
                sessions to start learning.
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-2.5 px-2 py-1 rounded bg-accent-soft border border-accent-line text-[10px] text-accent-green">
            <Zap size={10} />
            ~{formatTokenCount(tokenEstimate)} tok · injects automatically ·
            toggle per-conversation
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
}

function PatternRow({ pattern, meta, onDelete }: PatternRowProps) {
  const pct = Math.round(pattern.confidence * 100);
  return (
    <div className="group flex items-stretch gap-2.5 p-2.5 bg-bg-secondary border border-bg-border rounded-md hover:border-line-strong transition-colors">
      <div className={`w-1 self-stretch rounded-full ${meta.bar}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[11.5px] text-text-primary leading-snug">
          {pattern.pattern}
        </div>
        <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-16 h-[3px] rounded-full bg-bg-elevated overflow-hidden">
              <div
                className={`h-full ${meta.bar}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-[9.5px] text-text-faint tabular-nums">
              {pct}%
            </span>
          </div>
          <span className="text-[10px] text-text-faint">
            extracted {relativeTime(pattern.extractedAt)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="p-1 text-text-faint hover:text-accent-green rounded"
          title="Pin to top"
          disabled
        >
          <Star size={10} />
        </button>
        <button
          className="p-1 text-text-faint hover:text-text-primary rounded"
          title="Edit"
          disabled
        >
          <Edit3 size={10} />
        </button>
        <button
          onClick={onDelete}
          className="p-1 text-text-faint hover:text-accent-red rounded"
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
  onDeleteEvent: (id: string) => void;
}

function TimelineTab({
  filter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  counts,
  events,
  totalEvents,
  onDeleteEvent,
}: TimelineTabProps) {
  return (
    <>
      {/* Filter row */}
      <div className="flex items-center gap-1 px-3.5 py-2 bg-bg-secondary border-b border-bg-border flex-shrink-0">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => onFilterChange(f.key)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10.5px] rounded-full border transition-colors ${
                active
                  ? "bg-accent-soft border-accent-line text-accent-green font-semibold"
                  : "bg-transparent border-transparent text-text-muted hover:text-text-secondary font-medium"
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
        <div className="flex items-center gap-1.5 bg-bg-primary border border-bg-border rounded px-2 py-0.5 min-w-[220px]">
          <Search size={10} className="text-text-faint flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search memory..."
            className="bg-transparent text-[10.5px] text-text-primary placeholder:text-text-faint focus:outline-none w-full"
          />
        </div>
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto px-3.5 py-3 flex flex-col gap-2">
        {events.length === 0 ? (
          <EmptyState
            icon={<Brain size={20} className="text-text-faint" />}
            title={
              totalEvents === 0
                ? "No events yet"
                : "No events match your filter"
            }
            body={
              totalEvents === 0
                ? "Memory captures session, task, and flight completions automatically."
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

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  body: string;
}

function EmptyState({ icon, title, body }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-12 gap-2 text-center">
      <div className="opacity-60">{icon}</div>
      <p className="text-[11px] text-text-secondary">{title}</p>
      <p className="text-[10px] text-text-faint max-w-[260px] leading-relaxed">
        {body}
      </p>
    </div>
  );
}
