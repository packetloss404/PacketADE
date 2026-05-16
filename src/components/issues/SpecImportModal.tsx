// v0.8.5 — Spec → Issues import modal.
//
// Two-stage UX:
//
//   Stage 1: Paste. User pastes a spec / PRD / design doc into a big
//   textarea and hits "Extract tickets". We invoke the new
//   `issues_extract_from_spec` Tauri command which mounts a one-shot
//   `claude-oauth` sidecar session and returns parsed
//   `ExtractedIssueDraft[]`.
//
//   Stage 2: Review. Each draft renders as a row with title + body
//   preview + labels + acceptance criteria + a checkbox (all checked by
//   default). The user can edit any title/body inline. Hitting
//   "Create N tickets" generates a single `specImportBatchId` UUID and
//   stamps it on every created Issue so the IssueCard / IssueDetail
//   surfaces can show a "from spec import on {date}" badge that groups
//   siblings.
//
// Failure modes are handled inline:
//   - Failed AI call (sidecar error, timeout, transport): we surface the
//     error message + a Retry button. The textarea content is preserved
//     so the user can edit + retry without re-pasting.
//   - Failed JSON parse (model hallucinated prose): the backend returns
//     a preview of the raw response in the error message, which we show
//     verbatim above the Retry button.
//
// The modal is mounted from `IssueBoard.tsx` via an "Import spec" button
// at the top toolbar. Closing the modal at any point discards staged
// drafts — no auto-save.

import { useEffect, useState } from "react";
import {
  Loader2,
  Check,
  ChevronLeft,
  AlertCircle,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { issuesExtractFromSpec, type ExtractedIssueDraft } from "@/lib/tauri";
import { useIssueStore } from "@/stores/issueStore";
import { Modal } from "@/components/ui/Modal";
import { generateId } from "@/lib/storage";

interface SpecImportModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
}

// Local row shape: the AI draft plus the editable + selection bits the
// review stage needs. Title/body are split out as their own strings so
// inline edits don't have to deep-mutate the draft.
interface DraftRow {
  draft: ExtractedIssueDraft;
  title: string;
  body: string;
  selected: boolean;
}

type Phase = "paste" | "loading" | "preview";

/**
 * Build a fresh `DraftRow` for each AI-extracted draft. Every row starts
 * `selected: true` per the spec ("all checked by default").
 */
function toRows(drafts: ExtractedIssueDraft[]): DraftRow[] {
  return drafts.map((d) => ({
    draft: d,
    title: d.title,
    body: d.body,
    selected: true,
  }));
}

/**
 * Generate a UUID for the import-batch stamp. Uses `crypto.randomUUID`
 * because that's the convention used elsewhere in the codebase (see
 * `PRReviewPanel.tsx`, `PRDescriptionButton.tsx`). Falls back to the
 * shared `generateId` helper for ancient runtimes that lack the API —
 * which Tauri's bundled webview will never be on, but keeps the type
 * safe in tests.
 */
function newBatchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return generateId("spec-batch", 16);
}

export function SpecImportModal({ open, onClose, projectPath }: SpecImportModalProps) {
  const [phase, setPhase] = useState<Phase>("paste");
  const [specText, setSpecText] = useState("");
  const [rows, setRows] = useState<DraftRow[]>([]);
  // We track the error message AND whether the failure looks like a
  // parse error (versus a transport / model error). Parse errors include
  // a preview of the raw response in the message, so we render them in
  // a wider `<pre>` block. Transport errors get a single-line callout.
  const [error, setError] = useState<string | null>(null);

  const addIssue = useIssueStore((s) => s.addIssue);

  // v0.8.8 (edge case 4): capture the `projectPath` on open. The parent
  // (`IssueBoard.tsx`) passes a live expression — `activeWorkspace?.
  // projectPath || useLayoutStore.getState().projectPath` — which can
  // change mid-edit if the user switches/archives/deletes the active
  // workspace in another pane. Capture-on-open guarantees the spec
  // extraction runs against the same project the user thought they
  // were targeting when they pasted.
  const [capturedProjectPath, setCapturedProjectPath] = useState<string>(projectPath);
  useEffect(() => {
    if (open) {
      setCapturedProjectPath(projectPath);
    }
    // Intentionally NOT depending on `projectPath` — sample only on the
    // open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const selectedCount = rows.filter((r) => r.selected).length;
  const canCreate = selectedCount > 0 && rows.every((r) => !r.selected || r.title.trim().length > 0);

  async function handleExtract() {
    const trimmed = specText.trim();
    if (!trimmed) return;
    setError(null);
    setPhase("loading");
    try {
      const drafts = await issuesExtractFromSpec(trimmed, capturedProjectPath);
      if (!Array.isArray(drafts) || drafts.length === 0) {
        throw new Error("The model returned zero tickets. Try a more concrete spec.");
      }
      setRows(toRows(drafts));
      setPhase("preview");
    } catch (e) {
      // The backend already formats parse failures with a "Raw preview:"
      // suffix, so just bubble the message through unchanged.
      setError(e instanceof Error ? e.message : String(e));
      setPhase("paste");
    }
  }

  function handleToggle(idx: number) {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, selected: !r.selected } : r)),
    );
  }

  function toggleAll() {
    const allChecked = rows.every((r) => r.selected);
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allChecked })));
  }

  function handleEditTitle(idx: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, title: value } : r)));
  }

  function handleEditBody(idx: number, value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, body: value } : r)));
  }

  function handleBackToPaste() {
    setPhase("paste");
    setRows([]);
    setError(null);
  }

  function handleCreate() {
    if (!canCreate) return;
    const batchId = newBatchId();
    for (const row of rows) {
      if (!row.selected) continue;
      const title = row.title.trim();
      if (!title) continue;
      // The AI's `acceptanceCriteria` is a string[]; the in-store Issue
      // uses `AcceptanceCriterion[]` (objects with `checked` state). Map
      // one to the other at creation time.
      const acceptanceCriteria = (row.draft.acceptanceCriteria ?? []).map((text) => ({
        id: generateId("ac", 6),
        text,
        checked: false,
      }));
      addIssue({
        title,
        description: row.body.trim(),
        // Land spec-imported Issues in Backlog so the user reviews + promotes
        // them deliberately rather than seeing them mixed into Up Next.
        status: "backlog",
        priority: "medium",
        labels: row.draft.labels ?? [],
        // The AI's `suggestedEpic` is a friendly grouping name. We stash
        // it in the Issue's `epic` slot so existing epic-based filters
        // pick it up; `null` when absent.
        epic: row.draft.suggestedEpic?.trim() || null,
        acceptanceCriteria,
        blockedBy: [],
        blocks: [],
        specImportBatchId: batchId,
      });
    }
    // Reset internal state before closing so a re-open lands on Stage 1.
    setPhase("paste");
    setRows([]);
    setSpecText("");
    setError(null);
    onClose();
  }

  // -----------------------------------------------------------------------
  // Footer (rendered conditionally per phase)
  // -----------------------------------------------------------------------
  let footer: React.ReactNode = null;
  if (phase === "paste") {
    footer = (
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-text-muted">
          {specText.trim().length > 0
            ? `${specText.trim().length} characters`
            : "Paste your spec to begin"}
        </span>
        <button
          onClick={handleExtract}
          disabled={!specText.trim()}
          className="inline-flex items-center gap-1.5 rounded bg-accent-green px-3 py-1.5 text-[11px] font-medium text-bg-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Sparkles size={11} />
          Extract tickets
        </button>
      </div>
    );
  } else if (phase === "preview") {
    footer = (
      <div className="flex items-center justify-between">
        <button
          onClick={handleBackToPaste}
          className="inline-flex items-center gap-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ChevronLeft size={12} />
          Back
        </button>
        <button
          onClick={handleCreate}
          disabled={!canCreate}
          className="rounded bg-accent-green px-3 py-1.5 text-[11px] font-medium text-bg-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Create {selectedCount} ticket{selectedCount === 1 ? "" : "s"}
        </button>
      </div>
    );
  }

  return (
    <Modal
      onClose={onClose}
      title="Import spec to issues"
      icon={<Sparkles size={14} className="text-accent-green" />}
      width="w-[820px] max-w-[92vw]"
      footer={footer}
    >
      <div className="p-5">
        {/* Stage 1 — paste */}
        {phase === "paste" && (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-text-muted">
              Paste a spec, PRD, design doc, or feature description. Claude
              breaks it into discrete Issue tickets sized to one Workspace
              session each.
            </p>
            {error && (
              <div className="flex flex-col gap-1.5 rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2">
                <div className="flex items-start gap-2">
                  <AlertCircle size={12} className="mt-0.5 flex-shrink-0 text-accent-red" />
                  <span className="whitespace-pre-wrap break-words text-[11px] text-accent-red">
                    {error}
                  </span>
                </div>
                <button
                  onClick={handleExtract}
                  disabled={!specText.trim()}
                  className="ml-auto inline-flex items-center gap-1 text-[10px] text-accent-red transition-opacity hover:opacity-80 disabled:opacity-40"
                >
                  <RefreshCw size={10} />
                  Retry
                </button>
              </div>
            )}
            <textarea
              value={specText}
              onChange={(e) => setSpecText(e.target.value)}
              rows={12}
              placeholder="Paste your spec, PRD, design doc, or feature description. AI will break it into discrete Issue tickets."
              className="w-full resize-y rounded border border-bg-border bg-bg-primary px-3 py-2 font-mono text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
            />
          </div>
        )}

        {/* Stage 1.5 — loading */}
        {phase === "loading" && (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Loader2 size={24} className="animate-spin text-accent-green" />
            <span className="text-xs text-text-muted">
              Claude is breaking your spec into tickets…
            </span>
          </div>
        )}

        {/* Stage 2 — review */}
        {phase === "preview" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-muted">
                {selectedCount} of {rows.length} ticket{rows.length === 1 ? "" : "s"} selected
              </span>
              <button
                onClick={toggleAll}
                className="text-[10px] text-accent-green transition-opacity hover:opacity-80"
              >
                {rows.every((r) => r.selected) ? "Deselect all" : "Select all"}
              </button>
            </div>

            <div
              className="flex flex-col gap-2 overflow-y-auto pr-1"
              style={{ maxHeight: "min(540px, 62vh)" }}
            >
              {rows.map((row, idx) => (
                <div
                  key={idx}
                  className={`flex gap-3 rounded border px-3 py-2.5 transition-colors ${
                    row.selected
                      ? "border-accent-green/40 bg-accent-green/5"
                      : "border-bg-border bg-bg-primary opacity-60"
                  }`}
                >
                  {/* Checkbox */}
                  <button
                    onClick={() => handleToggle(idx)}
                    aria-label={row.selected ? "Skip this ticket" : "Include this ticket"}
                    className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                      row.selected
                        ? "border-accent-green bg-accent-green"
                        : "border-bg-border bg-bg-primary"
                    }`}
                  >
                    {row.selected && <Check size={10} className="text-bg-primary" />}
                  </button>

                  {/* Content */}
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {/* Editable title */}
                    <input
                      type="text"
                      value={row.title}
                      onChange={(e) => handleEditTitle(idx, e.target.value)}
                      className="w-full bg-transparent text-[12px] font-semibold text-text-primary focus:outline-none"
                      placeholder="Ticket title"
                    />

                    {/* Suggested epic + labels */}
                    {(row.draft.suggestedEpic || (row.draft.labels && row.draft.labels.length > 0)) && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {row.draft.suggestedEpic && (
                          <span className="rounded border border-accent-line/40 bg-accent-soft px-1.5 py-0.5 text-[9px] font-medium text-accent-green">
                            {row.draft.suggestedEpic}
                          </span>
                        )}
                        {row.draft.labels?.map((label, i) => (
                          <span
                            key={i}
                            className="rounded bg-bg-border px-1.5 py-0.5 text-[9px] text-text-muted"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Editable body */}
                    <textarea
                      value={row.body}
                      onChange={(e) => handleEditBody(idx, e.target.value)}
                      rows={3}
                      placeholder="Ticket body / description"
                      className="w-full resize-y rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-secondary placeholder:text-text-muted focus:border-accent-green focus:outline-none"
                    />

                    {/* Acceptance criteria preview */}
                    {row.draft.acceptanceCriteria && row.draft.acceptanceCriteria.length > 0 && (
                      <div className="flex flex-col gap-0.5 rounded border border-bg-border bg-bg-primary px-2 py-1.5">
                        <span className="text-[9px] uppercase tracking-wider text-text-muted">
                          Acceptance criteria
                        </span>
                        <ul className="flex flex-col gap-0.5">
                          {row.draft.acceptanceCriteria.map((ac, i) => (
                            <li
                              key={i}
                              className="text-[10px] text-text-secondary"
                            >
                              · {ac}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
