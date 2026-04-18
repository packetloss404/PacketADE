import { useMemo, useState } from "react";
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Loader2,
  Square,
  XCircle,
} from "lucide-react";

import type { AgentToolCall } from "@/types/agent-conversation";

interface TaskListCardProps {
  toolCall: AgentToolCall;
  verbosity?: "summary" | "normal" | "verbose";
}

type ParsedStatus = "pending" | "in_progress" | "completed";

interface ParsedTask {
  status: ParsedStatus;
  title: string;
}

/**
 * Parse the markdown checklist returned by the `task_list` tool.
 *
 * Format (one per line):
 *   - [ ] pending title
 *   - [~] in-progress title
 *   - [x] completed title
 *
 * Anything else is ignored so the card degrades gracefully if the agent
 * adds notes around the list.
 */
function parseChecklist(content: string): ParsedTask[] {
  const lines = content.split("\n");
  const out: ParsedTask[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*-\s*\[(.)\]\s*(.+?)\s*$/);
    if (!m) continue;
    const marker = m[1].toLowerCase();
    const title = m[2];
    let status: ParsedStatus;
    if (marker === "x") status = "completed";
    else if (marker === "~") status = "in_progress";
    else if (marker === " " || marker === "") status = "pending";
    else continue;
    out.push({ status, title });
  }
  return out;
}

function StatusIcon({ status }: { status: ParsedStatus }) {
  if (status === "completed") {
    return <CheckSquare size={11} className="text-accent-green shrink-0" />;
  }
  if (status === "in_progress") {
    return (
      <Loader2 size={11} className="text-accent-blue shrink-0 animate-spin" />
    );
  }
  return <Square size={11} className="text-text-muted shrink-0" />;
}

function rowClassName(status: ParsedStatus): string {
  if (status === "completed") return "text-accent-green line-through opacity-80";
  if (status === "in_progress") return "text-accent-blue";
  return "text-text-muted";
}

export function TaskListCard({ toolCall, verbosity = "normal" }: TaskListCardProps) {
  const [expanded, setExpanded] = useState(verbosity !== "summary");

  const content = toolCall.fullContent ?? toolCall.summary ?? "";
  const tasks = useMemo(() => parseChecklist(content), [content]);

  const counts = useMemo(() => {
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    for (const t of tasks) {
      if (t.status === "completed") completed++;
      else if (t.status === "in_progress") inProgress++;
      else pending++;
    }
    return { pending, inProgress, completed, total: tasks.length };
  }, [tasks]);

  if (toolCall.status === "error") {
    return (
      <div className="border border-accent-red/30 rounded text-[10px] text-accent-red bg-accent-red/5 px-2 py-1 flex items-center gap-1.5">
        <XCircle size={11} />
        <span className="font-mono">task_list</span>
        <span className="truncate">{content || "failed"}</span>
      </div>
    );
  }

  // While streaming, parsing may yield nothing — fall back to a tiny header.
  if (tasks.length === 0) {
    return (
      <div className="border border-bg-border rounded text-[10px] text-text-muted bg-bg-hover px-2 py-1 flex items-center gap-1.5">
        {toolCall.status === "running" ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Square size={11} />
        )}
        <span className="font-mono">task_list</span>
        <span className="text-text-muted/80">
          {content.trim() || "no tasks"}
        </span>
      </div>
    );
  }

  return (
    <div className="border border-bg-border rounded bg-bg-hover">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-bg-border/50 transition-colors rounded-t"
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <CheckSquare size={11} className="text-accent-green" />
        <span className="text-[10px] font-mono text-text-secondary">tasks</span>
        <span className="text-[10px] text-text-muted">
          {counts.completed}/{counts.total} done
          {counts.inProgress > 0 ? ` · ${counts.inProgress} in progress` : ""}
        </span>
      </button>
      {expanded && (
        <ul className="px-2 pb-1.5 pt-0.5 space-y-0.5">
          {tasks.map((t, i) => (
            <li
              key={`${i}-${t.title}`}
              className={`flex items-center gap-1.5 text-[11px] leading-snug ${rowClassName(t.status)}`}
            >
              <StatusIcon status={t.status} />
              <span className="truncate">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
