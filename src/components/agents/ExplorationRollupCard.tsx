import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Compass } from "lucide-react";
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

function parseInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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

export function ExplorationRollupCard({ toolCalls }: ExplorationRollupCardProps) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo<ExplorationStats>(() => {
    const fileReads: ExplorationStats["fileReads"] = [];
    const searches: ExplorationStats["searches"] = [];
    const listings: ExplorationStats["listings"] = [];
    for (const tc of toolCalls) {
      if (tc.status === "running") continue;
      const args = parseInput(tc.input);
      if (READ_TOOLS.has(tc.name)) {
        fileReads.push({ id: tc.id, path: pickPath(args) || tc.file || "" });
      } else if (SEARCH_TOOLS.has(tc.name)) {
        searches.push({ id: tc.id, query: pickQuery(args) });
      } else if (LIST_TOOLS.has(tc.name)) {
        listings.push({ id: tc.id, path: pickPath(args) });
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
    <div className="bg-bg-hover/60 rounded text-[10px] text-text-muted border border-bg-border/50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-bg-tertiary transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={10} className="shrink-0" />
        ) : (
          <ChevronRight size={10} className="shrink-0" />
        )}
        <Compass size={11} className="text-text-muted shrink-0" />
        <span className="text-[11px] text-text-secondary truncate flex-1">{summary}</span>
      </button>
      {expanded && (
        <div className="px-2 pb-1.5 border-t border-bg-border/40 flex flex-col gap-0.5">
          {stats.fileReads.length > 0 && (
            <div className="pt-1">
              <div className="text-[9px] uppercase tracking-wide text-text-muted/70 mb-0.5">
                Read
              </div>
              {stats.fileReads.map((r) => (
                <div
                  key={r.id}
                  className="font-mono text-[10px] text-text-secondary truncate"
                  title={r.path}
                >
                  {r.path || "(unknown path)"}
                </div>
              ))}
            </div>
          )}
          {stats.searches.length > 0 && (
            <div className="pt-1">
              <div className="text-[9px] uppercase tracking-wide text-text-muted/70 mb-0.5">
                Searched
              </div>
              {stats.searches.map((s) => (
                <div
                  key={s.id}
                  className="font-mono text-[10px] text-text-secondary truncate"
                  title={s.query}
                >
                  {s.query || "(empty query)"}
                </div>
              ))}
            </div>
          )}
          {stats.listings.length > 0 && (
            <div className="pt-1">
              <div className="text-[9px] uppercase tracking-wide text-text-muted/70 mb-0.5">
                Listed
              </div>
              {stats.listings.map((l) => (
                <div
                  key={l.id}
                  className="font-mono text-[10px] text-text-secondary truncate"
                  title={l.path}
                >
                  {l.path || "(unknown path)"}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
