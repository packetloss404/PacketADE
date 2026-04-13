import { useState, useMemo } from "react";
import { Brain, Search, FolderSearch, Loader2, Trash2 } from "lucide-react";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { MemoryEventCard } from "./memory/MemoryEventCard";
import type { MemoryEventType } from "@/types/memory";

type FilterType = "all" | MemoryEventType;

const FILTERS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "session_completed", label: "Sessions" },
  { key: "task_completed", label: "Tasks" },
  { key: "flight_completed", label: "Flights" },
];

export function MemoryView() {
  const projectPath = useLayoutStore((s) => s.projectPath);
  const events = useMemoryStore((s) => s.events);
  const fileMap = useMemoryStore((s) => s.fileMap);
  const lastScanAt = useMemoryStore((s) => s.lastScanAt);
  const isScanning = useMemoryStore((s) => s.isScanning);
  const scanError = useMemoryStore((s) => s.scanError);
  const scanCodebase = useMemoryStore((s) => s.scanCodebase);
  const deleteEvent = useMemoryStore((s) => s.deleteEvent);
  const clearMemory = useMemoryStore((s) => s.clearMemory);

  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFileMap, setShowFileMap] = useState(false);

  const filtered = useMemo(() => {
    let result = [...events].reverse(); // newest first
    if (filter !== "all") {
      result = result.filter((e) => e.type === filter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((e) => {
        const payload = e.payload;
        const searchable = JSON.stringify(payload).toLowerCase();
        return searchable.includes(q);
      });
    }
    return result;
  }, [events, filter, searchQuery]);

  function handleScan() {
    if (projectPath) void scanCodebase(projectPath);
  }

  function handleClear() {
    if (window.confirm("Clear all memory events? This cannot be undone.")) {
      clearMemory();
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* Header */}
      <div className="flex flex-col border-b border-bg-border">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Brain size={14} className="text-accent-purple" />
          <h2 className="text-xs font-semibold text-text-primary">Memory</h2>
          <span className="text-[10px] text-text-muted">
            {events.length} event{events.length !== 1 ? "s" : ""}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setShowFileMap(!showFileMap)}
            className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded transition-colors ${
              showFileMap ? "bg-bg-elevated text-accent-purple" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <FolderSearch size={11} />
            File Map {fileMap.length > 0 ? `(${fileMap.length})` : ""}
          </button>
          <button
            onClick={handleScan}
            disabled={isScanning || !projectPath}
            className="px-2.5 py-1 text-[11px] text-accent-green bg-accent-green/10 border border-accent-green/30 rounded hover:bg-accent-green/20 transition-colors disabled:opacity-40"
          >
            {isScanning ? <Loader2 size={11} className="animate-spin" /> : "Scan Codebase"}
          </button>
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

        {/* Filter row */}
        <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-secondary">
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
      </div>

      {/* Scan error */}
      {scanError && (
        <div className="mx-4 mt-2 px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded text-[11px] text-accent-red">
          {scanError}
        </div>
      )}

      {/* File Map (collapsible) */}
      {showFileMap && fileMap.length > 0 && (
        <div className="mx-4 mt-3 border border-bg-border rounded bg-bg-secondary">
          <div className="px-3 py-1.5 border-b border-bg-border">
            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">
              File Map
            </span>
            {lastScanAt && (
              <span className="text-[9px] text-text-muted ml-2">
                scanned {new Date(lastScanAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="max-h-[200px] overflow-y-auto px-3 py-1.5 space-y-0.5">
            {fileMap.map((f) => (
              <div key={f.path} className="flex gap-2 text-[10px]">
                <span className="text-text-primary font-mono shrink-0">{f.path}</span>
                <span className="text-text-muted truncate">{f.summary}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
            <Brain size={28} className="text-accent-purple/30" />
            <p className="text-xs text-center">
              {events.length === 0
                ? "No memory events yet. Memory captures automatically when sessions end, tasks complete, or flights finish."
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
    </div>
  );
}
