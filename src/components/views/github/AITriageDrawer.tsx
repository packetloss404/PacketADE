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
import { AlertCircle, AlertTriangle, Check, Loader2, Sparkles } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
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
        const labels = s.suggestedLabels.filter((l) => row.acceptedLabels[l]);
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
    <Modal
      onClose={onClose}
      title="AI triage"
      icon={<Sparkles size={14} className="text-accent-blue" />}
      width="w-[760px]"
      headerExtra={
        <span className="text-[10px] text-text-muted">
          {untriagedIssues.length} untriaged · {selectedNumbers.length} selected
        </span>
      }
      footer={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">
            {suggestions.length > 0
              ? `${suggestions.length} suggestion${suggestions.length === 1 ? "" : "s"}`
              : `${selectedNumbers.length} to triage`}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[10.5px] font-medium text-text-muted transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
          {suggestions.length === 0 ? (
            <button
              type="button"
              onClick={runTriage}
              disabled={running || selectedNumbers.length === 0}
              className="bg-accent-blue/15 border-accent-blue/30 hover:bg-accent-blue/25 inline-flex items-center gap-1.5 rounded border px-3 py-1 text-[10.5px] font-medium text-accent-blue transition-colors disabled:opacity-50"
            >
              {running ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              Run triage
            </button>
          ) : (
            <button
              type="button"
              onClick={applySelected}
              disabled={applying || applied}
              className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 inline-flex items-center gap-1.5 rounded border px-3 py-1 text-[10.5px] font-medium text-accent-green transition-colors disabled:opacity-50"
            >
              {applying ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              Apply selected
            </button>
          )}
        </div>
      }
    >
      <div className="px-5 py-3">
        {suggestions.length === 0 ? (
          // Pre-run: render the selection list.
          <>
            <p className="mb-2.5 text-[11px] text-text-muted">
              Select the issues you want the model to triage. All issues with no labels are selected
              by default; uncheck any you want to skip. Batches of {TRIAGE_BATCH_SIZE} are sent at a
              time.
            </p>
            {untriagedIssues.length === 0 ? (
              <p className="py-6 text-center text-[11px] text-text-muted">
                No untriaged issues — nothing to do.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {untriagedIssues.map((iss) => {
                  const row = rows[iss.number] ?? defaultRowState();
                  return (
                    <li
                      key={iss.number}
                      className="flex items-start gap-2 rounded border border-bg-border bg-bg-primary px-2.5 py-2"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={row.selected}
                        onChange={() => toggleRow(iss.number)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[10px] tabular-nums text-text-muted">
                            #{iss.number}
                          </span>
                          <span className="truncate text-[11px] leading-snug text-text-primary">
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
              const isDup = typeof s.duplicateOf === "number" && s.duplicateOf > 0;
              return (
                <li
                  key={s.number}
                  className={`rounded-lg border bg-bg-primary p-3 ${
                    row.selected ? "border-bg-border" : "border-bg-border opacity-50"
                  }`}
                >
                  <div className="mb-1.5 flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={row.selected}
                      onChange={() => toggleRow(s.number)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-1.5">
                        <span className="text-[10px] tabular-nums text-text-muted">
                          #{s.number}
                        </span>
                        <span className="text-[11.5px] font-medium leading-snug text-text-primary">
                          {issue?.title ?? `(unknown #${s.number})`}
                        </span>
                        <span
                          className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${priorityColor(
                            s.priority,
                          )}`}
                        >
                          {s.priority}
                        </span>
                      </div>
                      <p className="mt-1 text-[10.5px] leading-relaxed text-text-muted">
                        {s.rationale}
                      </p>
                      {isDup && (
                        <p className="text-accent-orange mt-1 flex items-center gap-1 text-[10px]">
                          <AlertTriangle size={10} />
                          Looks like a duplicate of #{s.duplicateOf} in this batch.
                        </p>
                      )}
                    </div>
                  </div>
                  {s.suggestedLabels.length > 0 ? (
                    <div className="ml-6 flex flex-wrap gap-1.5">
                      {s.suggestedLabels.map((label) => {
                        const accepted = !!row.acceptedLabels[label];
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() => toggleLabel(s.number, label)}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                              accepted
                                ? "bg-accent-green/15 border-accent-green/30 text-accent-green"
                                : "border-bg-border bg-bg-tertiary text-text-muted"
                            }`}
                          >
                            {accepted ? <Check size={9} /> : <span className="w-[9px]" />}
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="ml-6 text-[10px] text-text-muted">No label suggestions.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <div className="bg-accent-red/10 border-accent-red/20 mt-3 flex items-center gap-2 rounded border px-3 py-2 text-[10.5px] text-accent-red">
            <AlertCircle size={11} />
            {error}
          </div>
        )}

        {applied && !error && (
          <div className="bg-accent-green/10 border-accent-green/20 mt-3 flex items-center gap-2 rounded border px-3 py-2 text-[10.5px] text-accent-green">
            <Check size={11} />
            Applied selected labels.
          </div>
        )}
      </div>
    </Modal>
  );
}
