// v0.8-F: AI issue triage drawer, mounted from the IssueList header.
//
// Walks the user through bulk-triaging untriaged issues:
//
//   1. Open drawer → all issues with no labels are pre-selected.
//   2. User unchecks issues they want to skip.
//   3. "Run triage" → batches selected numbers into groups of 20 and calls
//      `github_ai_triage` per batch.
//   4. Per-issue rows render suggested labels + priority + rationale +
//      duplicate-of warning, each with a checkbox.
//   5. "Apply selected" → fans out `setIssueLabels` for each issue with the
//      chips the user accepted.

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import type { GitHubIssue, TriageSuggestion } from "@/types/github";
import { githubAiTriage } from "@/lib/tauri";

const TRIAGE_BATCH_SIZE = 20;

interface AITriageDrawerProps {
  owner: string;
  repo: string;
  untriagedIssues: GitHubIssue[];
  onClose: () => void;
  /**
   * Fan out the user's accepted labels per issue. The host owns the actual
   * `github_set_issue_labels` calls (so it can route through whatever
   * store action exists — `githubStore.setIssueLabels` if v0.8-C merged,
   * raw `githubSetIssueLabels` otherwise).
   */
  onApply: (labelsByIssue: Record<number, string[]>) => Promise<void>;
}

interface RowState {
  // Selection at the issue-row level. When false, the row is excluded from
  // the triage request AND from the apply step.
  selected: boolean;
  // Per-suggested-label acceptance, keyed by label name.
  acceptedLabels: Record<string, boolean>;
}

function defaultRowState(): RowState {
  return { selected: true, acceptedLabels: {} };
}

function priorityColor(priority: string): string {
  switch (priority) {
    case "P0":
      return "bg-accent-red/15 text-accent-red border-accent-red/30";
    case "P1":
      return "bg-accent-orange/15 text-accent-orange border-accent-orange/30";
    case "P2":
      return "bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30";
    case "P3":
    default:
      return "bg-bg-tertiary text-text-secondary border-bg-border";
  }
}

export function AITriageDrawer({
  owner,
  repo,
  untriagedIssues,
  onClose,
  onApply,
}: AITriageDrawerProps) {
  // Each issue starts selected.
  const [rows, setRows] = useState<Record<number, RowState>>(() => {
    const out: Record<number, RowState> = {};
    for (const iss of untriagedIssues) {
      out[iss.number] = defaultRowState();
    }
    return out;
  });
  const [suggestions, setSuggestions] = useState<TriageSuggestion[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);

  // Keep the row map aligned with the incoming issues (handles late refreshes).
  useEffect(() => {
    setRows((prev) => {
      const out: Record<number, RowState> = {};
      for (const iss of untriagedIssues) {
        out[iss.number] = prev[iss.number] ?? defaultRowState();
      }
      return out;
    });
  }, [untriagedIssues]);

  const selectedNumbers = useMemo(
    () =>
      Object.entries(rows)
        .filter(([, r]) => r.selected)
        .map(([n]) => Number(n)),
    [rows],
  );

  function toggleRow(num: number) {
    setRows((prev) => ({
      ...prev,
      [num]: { ...prev[num], selected: !prev[num]?.selected },
    }));
  }

  function toggleLabel(num: number, label: string) {
    setRows((prev) => {
      const row = prev[num] ?? defaultRowState();
      return {
        ...prev,
        [num]: {
          ...row,
          acceptedLabels: {
            ...row.acceptedLabels,
            [label]: !row.acceptedLabels[label],
          },
        },
      };
    });
  }

  async function runTriage() {
    if (selectedNumbers.length === 0) {
      setError("Select at least one issue to triage.");
      return;
    }
    setRunning(true);
    setError(null);
    setSuggestions([]);
    setApplied(false);

    try {
      // Slice into batches of TRIAGE_BATCH_SIZE — backend enforces a hard
      // cap so we MUST slice rather than let the backend reject a big batch.
      const batches: number[][] = [];
      for (let i = 0; i < selectedNumbers.length; i += TRIAGE_BATCH_SIZE) {
        batches.push(selectedNumbers.slice(i, i + TRIAGE_BATCH_SIZE));
      }

      const collected: TriageSuggestion[] = [];
      for (const batch of batches) {
        const batchResult = await githubAiTriage(owner, repo, batch);
        collected.push(...batchResult);
      }
      setSuggestions(collected);

      // Pre-check every suggested label so the default action of "Apply
      // selected" is the model's full recommendation. Users opt out by
      // unchecking.
      setRows((prev) => {
        const next = { ...prev };
        for (const s of collected) {
          const accepted: Record<string, boolean> = {};
          for (const l of s.suggestedLabels) accepted[l] = true;
          next[s.number] = {
            selected: next[s.number]?.selected ?? true,
            acceptedLabels: accepted,
          };
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  async function applySelected() {
    setApplying(true);
    setError(null);
    try {
      const payload: Record<number, string[]> = {};
      for (const s of suggestions) {
        const row = rows[s.number];
        if (!row?.selected) continue;
        const labels = s.suggestedLabels.filter(
          (l) => row.acceptedLabels[l],
        );
        // Even an empty array is a valid "clear labels" intent — but the
        // user probably didn't mean that. Skip rows where the user
        // unchecked every chip so we don't accidentally wipe labels.
        if (labels.length === 0) continue;
        payload[s.number] = labels;
      }
      if (Object.keys(payload).length === 0) {
        setError("No labels selected to apply.");
        setApplying(false);
        return;
      }
      await onApply(payload);
      setApplied(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-bg-border rounded-lg w-[760px] max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-bg-border">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-accent-blue" />
            <h2 className="text-sm font-semibold text-text-primary">
              AI triage
            </h2>
            <span className="text-[10px] text-text-muted">
              {untriagedIssues.length} untriaged · {selectedNumbers.length}{" "}
              selected
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {suggestions.length === 0 ? (
            // Pre-run: render the selection list.
            <>
              <p className="text-[11px] text-text-muted mb-2.5">
                Select the issues you want the model to triage. All issues
                with no labels are selected by default; uncheck any you want
                to skip. Batches of {TRIAGE_BATCH_SIZE} are sent at a time.
              </p>
              {untriagedIssues.length === 0 ? (
                <p className="text-[11px] text-text-muted py-6 text-center">
                  No untriaged issues — nothing to do.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {untriagedIssues.map((iss) => {
                    const row = rows[iss.number] ?? defaultRowState();
                    return (
                      <li
                        key={iss.number}
                        className="flex items-start gap-2 px-2.5 py-2 border border-bg-border rounded bg-bg-primary"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={row.selected}
                          onChange={() => toggleRow(iss.number)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[10px] text-text-muted tabular-nums">
                              #{iss.number}
                            </span>
                            <span className="text-[11px] text-text-primary leading-snug truncate">
                              {iss.title}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            // Post-run: render suggestions with per-label chips.
            <ul className="flex flex-col gap-3">
              {suggestions.map((s) => {
                const issue = untriagedIssues.find((i) => i.number === s.number);
                const row = rows[s.number] ?? defaultRowState();
                const isDup =
                  typeof s.duplicateOf === "number" && s.duplicateOf > 0;
                return (
                  <li
                    key={s.number}
                    className={`border rounded-lg p-3 bg-bg-primary ${
                      row.selected ? "border-bg-border" : "border-bg-border opacity-50"
                    }`}
                  >
                    <div className="flex items-start gap-2 mb-1.5">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={row.selected}
                        onChange={() => toggleRow(s.number)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-[10px] text-text-muted tabular-nums">
                            #{s.number}
                          </span>
                          <span className="text-[11.5px] text-text-primary leading-snug font-medium">
                            {issue?.title ?? `(unknown #${s.number})`}
                          </span>
                          <span
                            className={`text-[9px] px-1.5 py-0.5 rounded-full border font-semibold ${priorityColor(
                              s.priority,
                            )}`}
                          >
                            {s.priority}
                          </span>
                        </div>
                        <p className="text-[10.5px] text-text-muted mt-1 leading-relaxed">
                          {s.rationale}
                        </p>
                        {isDup && (
                          <p className="text-[10px] text-accent-orange mt-1 flex items-center gap-1">
                            <AlertTriangle size={10} />
                            Looks like a duplicate of #{s.duplicateOf} in this
                            batch.
                          </p>
                        )}
                      </div>
                    </div>
                    {s.suggestedLabels.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 ml-6">
                        {s.suggestedLabels.map((label) => {
                          const accepted = !!row.acceptedLabels[label];
                          return (
                            <button
                              key={label}
                              type="button"
                              onClick={() => toggleLabel(s.number, label)}
                              className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                                accepted
                                  ? "bg-accent-green/15 text-accent-green border-accent-green/30"
                                  : "bg-bg-tertiary text-text-muted border-bg-border"
                              }`}
                            >
                              {accepted ? (
                                <Check size={9} />
                              ) : (
                                <span className="w-[9px]" />
                              )}
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-text-muted ml-6">
                        No label suggestions.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {error && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-accent-red/10 border border-accent-red/20 rounded text-[10.5px] text-accent-red">
              <AlertCircle size={11} />
              {error}
            </div>
          )}

          {applied && !error && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-accent-green/10 border border-accent-green/20 rounded text-[10.5px] text-accent-green">
              <Check size={11} />
              Applied selected labels.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-bg-border flex items-center gap-2">
          <span className="text-[10px] text-text-muted">
            {suggestions.length > 0
              ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}`
              : `${selectedNumbers.length} to triage`}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[10.5px] font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          {suggestions.length === 0 ? (
            <button
              type="button"
              onClick={runTriage}
              disabled={running || selectedNumbers.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-[10.5px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors disabled:opacity-50"
            >
              {running ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Sparkles size={11} />
              )}
              Run triage
            </button>
          ) : (
            <button
              type="button"
              onClick={applySelected}
              disabled={applying || applied}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-[10.5px] font-medium bg-accent-green/15 text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/25 transition-colors disabled:opacity-50"
            >
              {applying ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Check size={11} />
              )}
              Apply selected
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
