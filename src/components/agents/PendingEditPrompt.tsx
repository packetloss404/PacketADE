import { useMemo, useState } from "react";
import * as Diff from "diff";
import {
  ChevronDown,
  ChevronRight,
  FileEdit,
  Check,
  X,
  ListChecks,
} from "lucide-react";
import { ToolDiffView } from "./ToolDiffView";
import type { PendingEdit } from "@/types/agent-conversation";

interface PendingEditPromptProps {
  item: PendingEdit;
  projectPath: string;
  /** v3: when `mergedContent` is provided, the sidecar Anthropic provider
   * writes that content directly instead of letting the model's full `after`
   * land (per-hunk acceptance). In-process providers ignore the override. */
  onApply: (toolId: string, mergedContent?: string) => void;
  onReject: (toolId: string) => void;
}

/** A contiguous added/removed/unchanged region within a unified diff. */
interface Hunk {
  /** Stable id within this PendingEdit: index into the `Diff.diffLines` parts. */
  id: number;
  /** Original text from `before` (for removed/unchanged), used when reconstructing. */
  beforeText: string;
  /** Replacement text from `after` (for added/unchanged). */
  afterText: string;
  /** True if this hunk is a model-introduced change (added or removed lines). */
  isChange: boolean;
  /** True for added text, false for removed (only set when isChange). */
  isAddition?: boolean;
  /** Number of lines in the change (display only). */
  lineCount: number;
}

/**
 * Convert `Diff.diffLines` parts into UI hunks. Adjacent added+removed runs
 * are emitted as separate hunks so the user can accept either side
 * independently — matching how Cursor's hunk picker works.
 */
function buildHunks(before: string, after: string): Hunk[] {
  const parts = Diff.diffLines(before, after);
  const hunks: Hunk[] = [];
  let id = 0;
  for (const part of parts) {
    const text = part.value;
    const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
    const lineCount = trimmed.length === 0 ? 0 : trimmed.split("\n").length;
    if (part.added) {
      hunks.push({
        id: id++,
        beforeText: "",
        afterText: text,
        isChange: true,
        isAddition: true,
        lineCount,
      });
    } else if (part.removed) {
      hunks.push({
        id: id++,
        beforeText: text,
        afterText: "",
        isChange: true,
        isAddition: false,
        lineCount,
      });
    } else {
      hunks.push({
        id: id++,
        beforeText: text,
        afterText: text,
        isChange: false,
        lineCount,
      });
    }
  }
  return hunks;
}

/**
 * Build a merged file body honoring the user's per-hunk selections.
 * Unchanged hunks always pass through. For each *change* hunk:
 *   - selected = the model's proposed state lands (after for additions,
 *     removal stays removed for removals)
 *   - deselected = the original state survives (no addition; removed text
 *     is restored)
 */
function mergeHunks(hunks: Hunk[], selected: Set<number>): string {
  const out: string[] = [];
  for (const h of hunks) {
    if (!h.isChange) {
      out.push(h.beforeText);
      continue;
    }
    if (h.isAddition) {
      // Addition: include only when selected.
      if (selected.has(h.id)) out.push(h.afterText);
    } else {
      // Removal: drop only when selected; otherwise keep the original text.
      if (!selected.has(h.id)) out.push(h.beforeText);
    }
  }
  return out.join("");
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
  const [hunkPickerOpen, setHunkPickerOpen] = useState(false);

  const { added, removed, isNew } = useMemo(
    () => countQuickDiff(item.before, item.content),
    [item.before, item.content],
  );
  const hasCounts = item.before !== undefined;
  const fileName = basenameOf(item.path);

  // Build hunks lazily — only when the user opens the picker, since the
  // diff library's full-file diff isn't free for big files.
  const hunks = useMemo(
    () => (hunkPickerOpen ? buildHunks(item.before ?? "", item.content) : []),
    [hunkPickerOpen, item.before, item.content],
  );
  const changeHunks = useMemo(() => hunks.filter((h) => h.isChange), [hunks]);

  // Selection state — start with all change-hunks selected (= same as a
  // plain "Apply"). Users untick the ones they don't want.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Re-seed the selection set whenever the picker opens against new hunks.
  const hunkPickerKey = useMemo(
    () => (hunkPickerOpen ? changeHunks.map((h) => h.id).join(",") : ""),
    [hunkPickerOpen, changeHunks],
  );
  useMemo(() => {
    if (hunkPickerOpen) {
      setSelected(new Set(changeHunks.map((h) => h.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunkPickerKey]);

  const toggleHunk = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyMerged = () => {
    const merged = mergeHunks(hunks, selected);
    onApply(item.id, merged);
  };

  // Hunk picker is only meaningful when the file existed before AND the
  // diff has more than one change region. New files / single-hunk edits
  // collapse to a regular Apply / Reject.
  const canPickHunks = item.before !== undefined && changeHunks.length >= 2;

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

      {hunkPickerOpen && (
        <div className="border-t border-bg-border max-h-72 overflow-auto bg-bg-primary text-[10px]">
          <div className="px-2 py-1 text-text-muted">
            {selected.size} of {changeHunks.length} change hunks selected
          </div>
          {changeHunks.map((h) => {
            const isSelected = selected.has(h.id);
            const text = h.isAddition ? h.afterText : h.beforeText;
            const preview = text
              .replace(/\n+$/, "")
              .split("\n")
              .slice(0, 6)
              .join("\n");
            return (
              <label
                key={h.id}
                className={`flex gap-2 px-2 py-1 border-t border-bg-border cursor-pointer ${
                  isSelected ? "bg-bg-secondary" : "opacity-60"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleHunk(h.id)}
                  className="mt-0.5 shrink-0"
                />
                <div className="flex flex-col min-w-0 flex-1">
                  <span
                    className={`text-[9px] font-mono ${
                      h.isAddition ? "text-accent-green" : "text-accent-red"
                    }`}
                  >
                    {h.isAddition ? "+" : "-"} {h.lineCount} line
                    {h.lineCount === 1 ? "" : "s"}
                  </span>
                  <pre
                    className={`whitespace-pre-wrap break-all text-[10px] leading-tight font-mono mt-0.5 ${
                      h.isAddition ? "text-accent-green/90" : "text-accent-red/90"
                    }`}
                  >
                    {preview}
                  </pre>
                </div>
              </label>
            );
          })}
        </div>
      )}

      {/* Inline approve / reject — visible whether or not the diff is expanded */}
      <div className="flex flex-wrap gap-1.5 px-2 py-1.5 border-t border-bg-border bg-bg-primary">
        {hunkPickerOpen ? (
          <>
            <button
              type="button"
              onClick={applyMerged}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
              title="Write file with only the selected hunks"
            >
              <Check size={12} /> Apply selected ({selected.size})
            </button>
            <button
              type="button"
              onClick={() => setHunkPickerOpen(false)}
              className="text-[11px] px-2 py-1 rounded border border-bg-border text-text-secondary hover:bg-bg-hover"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onApply(item.id)}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
            >
              <Check size={12} /> Apply
            </button>
            {canPickHunks && (
              <button
                type="button"
                onClick={() => setHunkPickerOpen(true)}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/10"
                title="Pick which hunks to apply (sidecar Anthropic only)"
              >
                <ListChecks size={12} /> Pick hunks
              </button>
            )}
            <button
              type="button"
              onClick={() => onReject(item.id)}
              className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
            >
              <X size={12} /> Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}
