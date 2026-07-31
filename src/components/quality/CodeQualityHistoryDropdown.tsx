import { useEffect, useRef, useState } from "react";
import { ChevronDown, History, Trash2 } from "lucide-react";
import { formatScoreDelta, type CodeQualityHistoryEntry } from "./codeQualityHistory";
import { getLetterGrade } from "./codeQualityUtils";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";

interface Props {
  entries: CodeQualityHistoryEntry[];
  /** Currently shown entry — undefined when displaying the live report. */
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClear: () => void;
}

/**
 * Small header dropdown listing the last few quality runs for the current
 * project. Lets the user flip between historical snapshots and compare the
 * delta against the prior run.
 *
 * Index 0 is the most recent run (which is the "live" report after the
 * analyzer finishes). Selecting a different index swaps the visible report
 * without re-invoking the backend.
 */
export function CodeQualityHistoryDropdown({ entries, selectedIndex, onSelect, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const [pendingClear, setPendingClear] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (entries.length === 0) {
    return null;
  }

  const current = entries[selectedIndex] ?? entries[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-1 text-[10px] rounded border border-bg-border text-text-secondary hover:text-text-primary hover:border-bg-hover transition-colors"
        title="View prior Code Quality runs"
      >
        <History size={11} />
        <span>{entries.length === 1 ? "1 run" : `${entries.length} runs`}</span>
        <ChevronDown size={10} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-bg-secondary border border-bg-border rounded-lg shadow-lg z-10 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-bg-border">
            <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
              Recent runs
            </span>
            <button
              type="button"
              onClick={() => {
                setPendingClear(true);
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-accent-red transition-colors"
              title="Clear run history"
              aria-label="Clear run history"
            >
              <Trash2 size={10} /> Clear
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {entries.map((entry, idx) => {
              const grade = getLetterGrade(entry.totalScore);
              const delta = formatScoreDelta(entry.totalScore, entries[idx + 1]?.totalScore);
              const isCurrent = idx === selectedIndex;
              return (
                <button
                  key={entry.ranAt + "-" + idx}
                  type="button"
                  onClick={() => {
                    onSelect(idx);
                    setOpen(false);
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left transition-colors ${
                    isCurrent ? "bg-bg-hover" : "hover:bg-bg-hover/60"
                  }`}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                    style={{ backgroundColor: `${grade.color}22`, color: grade.color }}
                  >
                    {grade.letter}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-text-primary truncate">
                      {idx === 0 ? "Latest run" : `Run #${entries.length - idx}`}
                    </div>
                    <div className="text-[10px] text-text-muted truncate">
                      {new Date(entry.ranAt).toLocaleString()} · {entry.totalFiles} files · {entry.testFiles} tests
                    </div>
                  </div>
                  <span className="text-[10px] font-mono flex-shrink-0" style={{ color: delta.color }}>
                    {delta.text}
                  </span>
                </button>
              );
            })}
          </div>
          {current && (
            <div className="px-3 py-1.5 border-t border-bg-border text-[10px] text-text-muted">
              {selectedIndex === 0
                ? "Viewing latest run."
                : "Viewing historical snapshot — re-run to refresh."}
            </div>
          )}
        </div>
      )}

      {pendingClear && (
        <ConfirmDeleteModal
          title="Clear run history?"
          description={`All ${entries.length} saved quality runs for this project are removed, along with their score deltas.`}
          confirmLabel="Clear history"
          onConfirm={() => {
            onClear();
            setPendingClear(false);
          }}
          onClose={() => setPendingClear(false)}
        />
      )}
    </div>
  );
}
