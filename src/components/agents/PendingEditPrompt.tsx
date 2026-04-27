import { useMemo, useState } from "react";
import * as Diff from "diff";
import { ChevronDown, ChevronRight, FileEdit, Check, X } from "lucide-react";
import { ToolDiffView } from "./ToolDiffView";
import type { PendingEdit } from "@/types/agent-conversation";

interface PendingEditPromptProps {
  item: PendingEdit;
  projectPath: string;
  onApply: (toolId: string) => void;
  onReject: (toolId: string) => void;
}

function basenameOf(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

function countQuickDiff(before: string | undefined, after: string): {
  added: number;
  removed: number;
  isNew: boolean;
} {
  if (before === undefined) {
    return { added: 0, removed: 0, isNew: false };
  }
  if (before === "") {
    const lines = after.length === 0 ? 0 : after.split("\n").length;
    return { added: lines, removed: 0, isNew: true };
  }
  const parts = Diff.diffLines(before, after);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const trimmed = part.value.endsWith("\n")
      ? part.value.slice(0, -1)
      : part.value;
    const lines = trimmed.length === 0 ? 0 : trimmed.split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed, isNew: false };
}

export function PendingEditPrompt({ item, projectPath, onApply, onReject }: PendingEditPromptProps) {
  const [expanded, setExpanded] = useState(false);
  const { added, removed, isNew } = useMemo(
    () => countQuickDiff(item.before, item.content),
    [item.before, item.content],
  );
  const hasCounts = item.before !== undefined;
  const fileName = basenameOf(item.path);

  return (
    <div className="bg-bg-secondary border border-accent-amber/40 rounded overflow-hidden">
      {/* Compact header — Cursor-style one-liner with file + +/- counts */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-bg-tertiary transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-secondary shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-secondary shrink-0" />
        )}
        <FileEdit size={12} className="text-accent-amber shrink-0" />
        <span className="text-[11px] font-mono text-text-primary truncate flex-1" title={item.path}>
          {fileName}
        </span>
        {hasCounts && (
          <span className="flex items-center gap-1.5 shrink-0">
            {isNew && (
              <span className="text-[9px] px-1 py-px bg-accent-green/15 text-accent-green rounded">
                NEW
              </span>
            )}
            <span className="text-[11px] font-mono text-accent-green">+{added}</span>
            <span className="text-[11px] font-mono text-accent-red">-{removed}</span>
          </span>
        )}
        <span className="text-[9px] text-accent-amber shrink-0 ml-1">awaiting review</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-border max-h-64 overflow-auto">
          <ToolDiffView
            projectPath={projectPath}
            filePath={item.path}
            newContent={item.content}
            oldContent={item.before ?? undefined}
          />
        </div>
      )}

      {/* Inline approve / reject — visible whether or not the diff is expanded */}
      <div className="flex gap-1.5 px-2 py-1.5 border-t border-bg-border bg-bg-primary">
        <button
          type="button"
          onClick={() => onApply(item.id)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Apply
        </button>
        <button
          type="button"
          onClick={() => onReject(item.id)}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        >
          <X size={12} /> Reject
        </button>
      </div>
    </div>
  );
}
