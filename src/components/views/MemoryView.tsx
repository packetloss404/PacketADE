import { useState, useMemo } from "react";
import { Brain, Search, Trash2, Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { MemoryEventCard } from "./memory/MemoryEventCard";
import type { MemoryEventType, PatternCategory } from "@/types/memory";
import { relativeTime } from "@/lib/time";

type Tab = "patterns" | "timeline";
type FilterType = "all" | MemoryEventType;

const FILTERS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "session_completed", label: "Sessions" },
  { key: "task_completed", label: "Tasks" },
  { key: "flight_completed", label: "Flights" },
];

const CATEGORY_COLORS: Record<PatternCategory, string> = {
  architecture: "text-accent-blue bg-accent-blue/10",
  convention: "text-accent-green bg-accent-green/10",
  preference: "text-accent-amber bg-accent-amber/10",
  pitfall: "text-accent-red bg-accent-red/10",
};

export function MemoryView() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const events = useMemoryStore((s) => s.events);
  const patterns = useMemoryStore((s) => s.patterns);
  const lastPatternRefreshAt = useMemoryStore((s) => s.lastPatternRefreshAt);
  const isLearning = useMemoryStore((s) => s.isLearning);
  const learningStatus = useMemoryStore((s) => s.learningStatus);
  const deleteEvent = useMemoryStore((s) => s.deleteEvent);
  const deletePattern = useMemoryStore((s) => s.deletePattern);
  const refreshPatterns = useMemoryStore((s) => s.refreshPatterns);
  const clearMemory = useMemoryStore((s) => s.clearMemory);

  const [activeTab, setActiveTab] = useState<Tab>("patterns");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    let result = [...events].reverse();
    if (filter !== "all") {
      result = result.filter((e) => e.type === filter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((e) => {
        const searchable = JSON.stringify(e.payload).toLowerCase();
        return searchable.includes(q);
      });
    }
    return result;
  }, [events, filter, searchQuery]);

  const summarizedCount = events.filter(
    (e) => e.type === "session_completed" && e.payload.summary !== null,
  ).length;

  function handleRefreshPatterns() {
    if (projectPath) void refreshPatterns(projectPath);
  }

  function handleClear() {
    if (window.confirm("Clear all memory? This removes all events and learned patterns.")) {
      clearMemory();
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-bg-border">
        <Brain size={14} className="text-accent-purple" />
        <h2 className="text-xs font-semibold text-text-primary">Memory</h2>

        {/* Learning indicator */}
        {isLearning && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-accent-purple/10 rounded text-[10px] text-accent-purple">
            <Loader2 size={10} className="animate-spin" />
            {learningStatus ?? "Learning..."}
          </div>
        )}

        <div className="flex-1" />

        {/* Stats */}
        <span className="text-[10px] text-text-muted">
          {patterns.length} pattern{patterns.length !== 1 ? "s" : ""} · {events.length} event{events.length !== 1 ? "s" : ""}
        </span>

        {events.length > 0 && (
          <button
            onClick={handleClear}
            className="p-1 text-text-muted hover:text-accent-red transition-colors"
            title="Clear all memory"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-1.5 bg-bg-secondary border-b border-bg-border">
        <button
          onClick={() => setActiveTab("patterns")}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded transition-colors ${
            activeTab === "patterns"
              ? "bg-bg-elevated text-accent-purple font-medium"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Sparkles size={11} />
          Patterns
          {patterns.length > 0 && (
            <span className="text-[9px] px-1 bg-accent-purple/15 text-accent-purple rounded">
              {patterns.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("timeline")}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded transition-colors ${
            activeTab === "timeline"
              ? "bg-bg-elevated text-accent-green font-medium"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Events
          {events.length > 0 && (
            <span className="text-[9px] px-1 bg-bg-elevated text-text-muted rounded">
              {events.length}
            </span>
          )}
        </button>
      </div>

      {/* Content */}
      {activeTab === "patterns" && (
        <div className="flex-1 overflow-y-auto p-4">
          {/* Refresh patterns action */}
          <div className="flex items-center justify-between mb-4">
            <div className="text-[10px] text-text-muted">
              {lastPatternRefreshAt
                ? `Last refreshed ${relativeTime(lastPatternRefreshAt)}`
                : "Patterns are auto-extracted from session summaries"}
              {summarizedCount > 0 && ` · ${summarizedCount} summarized session${summarizedCount !== 1 ? "s" : ""}`}
            </div>
            <button
              onClick={handleRefreshPatterns}
              disabled={isLearning || !projectPath || summarizedCount === 0}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-accent-purple hover:bg-accent-purple/10 rounded transition-colors disabled:opacity-40"
            >
              <RefreshCw size={10} className={isLearning ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {patterns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
              <Sparkles size={28} className="text-accent-purple/30" />
              <p className="text-xs text-center">No patterns learned yet</p>
              <p className="text-[10px] text-center max-w-xs">
                Memory automatically learns from your sessions. Complete a few sessions and patterns will be extracted from what you worked on.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {patterns
                .sort((a, b) => b.confidence - a.confidence)
                .map((p) => (
                  <div
                    key={p.id}
                    className="flex items-start gap-3 px-3 py-2.5 bg-bg-secondary border border-bg-border rounded-lg group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLORS[p.category]}`}>
                          {p.category}
                        </span>
                        <span className="text-[9px] text-text-muted">
                          {Math.round(p.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="text-[11px] text-text-primary">{p.pattern}</p>
                    </div>
                    <button
                      onClick={() => deletePattern(p.id)}
                      className="p-0.5 text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="Remove pattern"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "timeline" && (
        <>
          {/* Filter row */}
          <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-secondary border-b border-bg-border">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  filter === f.key
                    ? "bg-accent-purple/15 text-accent-purple"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {f.label}
              </button>
            ))}
            <div className="flex-1" />
            <div className="flex items-center gap-1.5 bg-bg-primary border border-bg-border rounded px-2 py-0.5 max-w-[240px]">
              <Search size={10} className="text-text-muted flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memory..."
                className="bg-transparent text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none w-full"
              />
            </div>
          </div>

          {/* Timeline */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
                <Brain size={28} className="text-accent-purple/30" />
                <p className="text-xs text-center">
                  {events.length === 0
                    ? "No memory events yet. Memory learns automatically when sessions complete."
                    : "No events match your filter."}
                </p>
              </div>
            ) : (
              filtered.map((event) => (
                <MemoryEventCard
                  key={event.id}
                  event={event}
                  onDelete={() => deleteEvent(event.id)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
