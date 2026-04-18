import { useEffect, useMemo, useState } from "react";
import {
  CheckSquare,
  Square,
  Save,
  RotateCw,
  FilePlus2,
  FileDiff,
} from "lucide-react";
import { applyAcceptedHunks, parseHunks, type Hunk } from "@/lib/hunkDiff";

interface HunkSelectableDiffProps {
  originalContent: string | null;
  newContent: string;
  filePath: string;
  onApplySelection: (finalContent: string) => Promise<void>;
}

export function HunkSelectableDiff({
  originalContent,
  newContent,
  filePath,
  onApplySelection,
}: HunkSelectableDiffProps) {
  const isNewFile = originalContent === null;

  const hunks: Hunk[] = useMemo(() => {
    if (isNewFile) {
      // Synthesize a single hunk covering the whole new file so the same
      // accept/reject UI works for "new file" cases.
      const newLines = newContent.split("\n");
      if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
        newLines.pop();
      }
      return [
        {
          id: "hunk-0-1",
          startLine: 1,
          originalLines: [],
          newLines,
          context: { before: [], after: [] },
        },
      ];
    }
    return parseHunks(originalContent ?? "", newContent);
  }, [originalContent, newContent, isNewFile]);

  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(
    () => new Set(hunks.map((h) => h.id)),
  );
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset selection when the underlying diff changes (e.g. file switched or
  // disk content refreshed after an apply).
  useEffect(() => {
    setAcceptedIds(new Set(hunks.map((h) => h.id)));
    setError(null);
  }, [hunks]);

  const totalHunks = hunks.length;
  const selectedCount = acceptedIds.size;
  const allSelected = selectedCount === totalHunks && totalHunks > 0;
  const noneSelected = selectedCount === 0;

  function toggleHunk(id: string) {
    setAcceptedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function acceptAll() {
    setAcceptedIds(new Set(hunks.map((h) => h.id)));
  }

  function rejectAll() {
    setAcceptedIds(new Set());
  }

  async function handleApply() {
    if (applying) return;
    setApplying(true);
    setError(null);
    try {
      const final = applyAcceptedHunks(
        originalContent ?? "",
        hunks,
        acceptedIds,
      );
      await onApplySelection(final);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  if (totalHunks === 0) {
    return (
      <div className="bg-bg-primary">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-bg-border">
          <FileDiff size={12} className="text-text-secondary" />
          <span className="text-[11px] font-mono text-text-primary truncate flex-1">
            {filePath}
          </span>
        </div>
        <div className="px-3 py-4 text-[11px] text-text-muted italic">
          No changes vs. on-disk content.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bg-primary">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-bg-border">
        {isNewFile ? (
          <FilePlus2 size={12} className="text-accent-green" />
        ) : (
          <FileDiff size={12} className="text-text-secondary" />
        )}
        <span className="text-[11px] font-mono text-text-primary truncate flex-1">
          {filePath}
        </span>
        <span className="text-[10px] font-mono text-text-secondary">
          {selectedCount}/{totalHunks} hunks
        </span>
        <button
          type="button"
          onClick={acceptAll}
          disabled={allSelected}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Accept all hunks"
        >
          Accept all
        </button>
        <button
          type="button"
          onClick={rejectAll}
          disabled={noneSelected}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Reject all hunks"
        >
          Reject all
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={applying}
          className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-accent-green/15 border border-accent-green/40 text-accent-green hover:bg-accent-green/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Apply selected hunks to file on disk"
        >
          {applying ? (
            <RotateCw size={10} className="animate-spin" />
          ) : (
            <Save size={10} />
          )}
          Apply selected
        </button>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-accent-red border-b border-bg-border bg-accent-red/10">
          {error}
        </div>
      )}

      {/* Hunk cards */}
      <div className="flex flex-col gap-2 p-2">
        {hunks.map((hunk, idx) => {
          const accepted = acceptedIds.has(hunk.id);
          return (
            <div
              key={hunk.id}
              className={`rounded border transition-colors ${
                accepted
                  ? "border-accent-green/40 bg-bg-secondary/40"
                  : "border-bg-border bg-bg-secondary/20 opacity-70"
              }`}
            >
              {/* Hunk header */}
              <button
                type="button"
                onClick={() => toggleHunk(hunk.id)}
                className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-bg-hover/50 transition-colors rounded-t"
                title={accepted ? "Reject this hunk" : "Accept this hunk"}
              >
                {accepted ? (
                  <CheckSquare size={12} className="text-accent-green flex-shrink-0" />
                ) : (
                  <Square size={12} className="text-text-secondary flex-shrink-0" />
                )}
                <span className="text-[10px] font-mono text-text-secondary">
                  Hunk {idx + 1} @ line {hunk.startLine}
                </span>
                <span className="ml-auto flex items-center gap-1 text-[10px] font-mono">
                  <span className="text-accent-green">
                    +{hunk.newLines.length}
                  </span>
                  <span className="text-accent-red">
                    -{hunk.originalLines.length}
                  </span>
                </span>
              </button>

              {/* Hunk body */}
              <div className="border-t border-bg-border">
                {hunk.context.before.length > 0 && (
                  <ContextBlock lines={hunk.context.before} />
                )}
                {hunk.originalLines.length > 0 && (
                  <ChangeBlock lines={hunk.originalLines} kind="removed" />
                )}
                {hunk.newLines.length > 0 && (
                  <ChangeBlock lines={hunk.newLines} kind="added" />
                )}
                {hunk.context.after.length > 0 && (
                  <ContextBlock lines={hunk.context.after} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Sub-components                                */
/* -------------------------------------------------------------------------- */

function ContextBlock({ lines }: { lines: string[] }) {
  return (
    <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-text-secondary">
      {lines.map((line, idx) => (
        <div key={idx} className="px-3">
          <span className="inline-block w-4 text-text-muted select-none"> </span>
          {line}
        </div>
      ))}
    </pre>
  );
}

function ChangeBlock({
  lines,
  kind,
}: {
  lines: string[];
  kind: "added" | "removed";
}) {
  const rowClass =
    kind === "added"
      ? "bg-accent-green/10 text-accent-green"
      : "bg-accent-red/10 text-accent-red";
  const gutter = kind === "added" ? "+" : "-";
  return (
    <pre
      className={`text-[11px] font-mono whitespace-pre-wrap break-words ${rowClass}`}
    >
      {lines.map((line, idx) => (
        <div key={idx} className="px-3">
          <span className="inline-block w-4 text-text-secondary select-none">
            {gutter}
          </span>
          {line}
        </div>
      ))}
    </pre>
  );
}
