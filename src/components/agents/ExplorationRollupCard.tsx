import { memo, useMemo, useState } from "react";
import { ChevronRight, Compass } from "lucide-react";
import { parseToolInput } from "@/lib/parseToolInput";
import type { AgentToolCall } from "@/types/agent-conversation";

interface ExplorationRollupCardProps {
  toolCalls: AgentToolCall[];
}

interface ExplorationStats {
  fileReads: { id: string; path: string }[];
  searches: { id: string; query: string }[];
  listings: { id: string; path: string }[];
}

const READ_TOOLS = new Set(["read_file", "Read"]);
const SEARCH_TOOLS = new Set(["grep", "Grep", "glob", "Glob", "search"]);
const LIST_TOOLS = new Set(["list_directory", "list_files", "LS", "ls"]);

function pickPath(args: Record<string, unknown>): string {
  const candidates = ["path", "file_path", "rel_path", "filename", "file"];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function pickQuery(args: Record<string, unknown>): string {
  const candidates = ["query", "pattern", "search", "regex"];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function ExplorationRollupCardImpl({ toolCalls }: ExplorationRollupCardProps) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo<ExplorationStats>(() => {
    const fileReads: ExplorationStats["fileReads"] = [];
    const searches: ExplorationStats["searches"] = [];
    const listings: ExplorationStats["listings"] = [];
    for (const tc of toolCalls) {
      if (tc.status === "running") continue;
      const args = parseToolInput(tc.input) ?? {};
      if (READ_TOOLS.has(tc.name)) {
        const path = pickPath(args) || tc.file || "";
        if (path) fileReads.push({ id: tc.id, path });
      } else if (SEARCH_TOOLS.has(tc.name)) {
        const query = pickQuery(args);
        if (query) searches.push({ id: tc.id, query });
      } else if (LIST_TOOLS.has(tc.name)) {
        const path = pickPath(args);
        if (path) listings.push({ id: tc.id, path });
      }
    }
    return { fileReads, searches, listings };
  }, [toolCalls]);

  const total = stats.fileReads.length + stats.searches.length + stats.listings.length;
  if (total === 0) return null;

  const summaryParts: string[] = [];
  if (stats.fileReads.length > 0) {
    summaryParts.push(
      `${stats.fileReads.length} file${stats.fileReads.length === 1 ? "" : "s"}`,
    );
  }
  if (stats.searches.length > 0) {
    summaryParts.push(
      `${stats.searches.length} search${stats.searches.length === 1 ? "" : "es"}`,
    );
  }
  if (stats.listings.length > 0) {
    summaryParts.push(
      `${stats.listings.length} listing${stats.listings.length === 1 ? "" : "s"}`,
    );
  }
  const summary = `Explored ${summaryParts.join(", ")}`;

  return (
    <div className="bg-bg-hover rounded text-[10px] text-text-muted border border-bg-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-bg-elevated transition-colors text-left"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <Compass size={12} className="text-text-muted shrink-0" />
        <span className="text-[11px] text-text-secondary truncate flex-1">{summary}</span>
      </button>
      {expanded && (
        <div className="px-2 pb-1.5 border-t border-bg-border flex flex-col gap-0.5 max-h-64 overflow-y-auto">
          {stats.fileReads.length > 0 && (
            <div className="pt-1">
              <div className="text-[9px] uppercase tracking-wide text-text-faint mb-0.5">
                Read
              </div>
              {stats.fileReads.map((r) => (
                <div
                  key={r.id}
                  className="font-mono text-[10px] text-text-secondary truncate"
                  title={r.path}
                >
                  {r.path}
                </div>
              ))}
            </div>
          )}
          {stats.searches.length > 0 && (
            <div className="pt-1">
              <div className="text-[9px] uppercase tracking-wide text-text-faint mb-0.5">
                Searched
              </div>
              {stats.searches.map((s) => (
                <div
                  key={s.id}
                  className="font-mono text-[10px] text-text-secondary truncate"
                  title={s.query}
                >
                  {s.query}
                </div>
              ))}
            </div>
          )}
          {stats.listings.length > 0 && (
            <div className="pt-1">
              <div className="text-[9px] uppercase tracking-wide text-text-faint mb-0.5">
                Listed
              </div>
              {stats.listings.map((l) => (
                <div
                  key={l.id}
                  className="font-mono text-[10px] text-text-secondary truncate"
                  title={l.path}
                >
                  {l.path}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const ExplorationRollupCard = memo(ExplorationRollupCardImpl);
