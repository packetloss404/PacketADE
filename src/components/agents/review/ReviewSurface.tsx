import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckSquare,
  FileDiff,
  FilePlus2,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import {
  EMPTY_PENDING_EDITS,
  useAgentApprovalStore,
} from "@/stores/agentApprovalStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { editSignature, useReviewStore } from "@/stores/reviewStore";
import { applyAcceptedHunks, parseHunks, type Hunk } from "@/lib/hunkDiff";
import { writeFileContents } from "@/lib/tauri";
import {
  aggregateWriteFiles,
  joinAbsolutePath,
  type WriteFileEntry,
} from "@/lib/diffUtils";
import type { PendingEdit } from "@/types/agent-conversation";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  buildHunkRows,
  languageForPath,
  MAX_HIGHLIGHT_ROWS,
  type DiffRow,
} from "@/components/agents/diff/DiffRows";
import { CommentableRow } from "@/components/agents/diff/CommentableRow";
import { useFileDisk } from "@/components/agents/hooks/useFileDisk";
import {
  countReviewFiles,
  useDiffTotals,
} from "@/components/agents/hooks/useDiffTotals";

/**
 * THE canonical review surface (consensus P1-8). One multibuffer pane that
 * covers every file the conversation touched, rendered exclusively with the
 * shared DiffRows renderer on lib/hunkDiff's probe-verified hunk engine.
 *
 * Two section kinds, one verb pair (Keep/Undo — the moderator-ruled
 * post-hoc pair; blocking Allow/Deny prompts stay in PermissionPrompt and
 * are never mixed in here):
 *
 *  - Pending sections: gated edits awaiting a decision. Every decision
 *    routes through `respondEdit` — Keep applies (per-hunk selections merge
 *    via `applyAcceptedHunks`), Undo-all rejects — so the agent is never
 *    left blocked and "Undo" never lies to the model. There is NO
 *    direct-to-disk apply side door.
 *
 *  - Applied sections: edits already on disk, diffed against the recorded
 *    pre-edit baseline (editBaselineStore). Per-hunk Undo restores the
 *    baseline lines for that hunk (a user-initiated revert — nothing is
 *    pending, so no protocol response exists or is faked). Each file
 *    carries a persisted GitHub-style "Viewed" checkbox (reviewStore).
 *
 * Per-row line comments (CommentableRow hover-`+`, PROTECTED) work on every
 * row; queued comments surface in PendingDiffCommentsStrip above the
 * composer and fold into the next turn.
 */

export interface ReviewSurfaceProps {
  conversationId: string;
  /** Render without panel chrome (the inspector Diff tab). The expanded
   * chat-pane panel omits it and passes `onClose` instead. */
  embedded?: boolean;
  /** When provided, renders a close button and closes on Escape. */
  onClose?: () => void;
}

export function ReviewSurface({
  conversationId,
  embedded = false,
  onClose,
}: ReviewSurfaceProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const pendingEdits = useAgentApprovalStore(
    (s) => s.edits.get(conversationId) ?? EMPTY_PENDING_EDITS,
  );
  // Re-collect the reviewable file list when a baseline lands (an Edit chain
  // becomes materializable the moment its edit_baseline event arrives).
  const baselinePaths = useEditBaselineStore((s) =>
    s.byConversation.get(conversationId),
  );
  const focusPath = useReviewStore((s) =>
    s.conversationId === conversationId ? s.focusPath : null,
  );

  const totals = useDiffTotals(conversation);

  const appliedEntries = useMemo(() => {
    const map = aggregateWriteFiles(conversation);
    const pendingPaths = new Set(pendingEdits.map((e) => e.path));
    return [...map.values()]
      .filter((e) => !pendingPaths.has(e.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    // `baselinePaths` is a re-run trigger (aggregateWriteFiles reads the
    // baseline store via getState()), not read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, pendingEdits, baselinePaths]);

  // Escape closes the expanded panel, matching the app's overlay convention.
  // Never while typing: the PROTECTED line-comment composer (and the main
  // composer below the overlay) own Escape in their own inputs — a handled
  // (defaultPrevented) or input-targeted Escape must not also collapse the
  // review and lose the user's place.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Deep-link scroll: MultiFileEditCard / transcript chips open the surface
  // focused on one file; scroll its section into view once it's mounted.
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());
  const registerSection = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      if (el) sectionRefs.current.set(path, el);
      else sectionRefs.current.delete(path);
    },
    [],
  );
  useEffect(() => {
    if (!focusPath) return;
    const el = sectionRefs.current.get(focusPath);
    if (el) el.scrollIntoView({ block: "start" });
  }, [focusPath, appliedEntries.length, pendingEdits.length]);

  const isEmpty = pendingEdits.length === 0 && appliedEntries.length === 0;
  const projectPath = conversation?.projectPath ?? "";
  // Gated files usually already count in `totals` (their tool call is in
  // the transcript pre-approval) — union, never sum, or one file shows as 2.
  const fileCount = countReviewFiles(totals, pendingEdits);

  return (
    <div
      className="h-full flex flex-col bg-bg-primary"
      role="region"
      aria-label="Review changes"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary shrink-0">
        <FileDiff size={12} className="text-text-secondary" />
        <span className="text-[11px] font-medium text-text-primary">
          {embedded ? "Changes" : "Review changes"}
        </span>
        <span className="text-[10px] font-mono text-text-secondary">
          {fileCount} {fileCount === 1 ? "file" : "files"}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-mono">
          <span className="text-accent-green">+{totals.totalAdds}</span>
          <span className="text-accent-red">-{totals.totalDels}</span>
        </span>
        {pendingEdits.length > 0 && (
          <span className="text-[10px] text-accent-amber">
            {pendingEdits.length} awaiting review
          </span>
        )}
        <span className="flex-1" />
        {onClose && (
          <Tooltip content="Close (Esc)">
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Close review"
            >
              <X size={14} />
            </button>
          </Tooltip>
        )}
      </div>

      {isEmpty ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<FileDiff size={24} />}
            title="No file edits in this conversation yet."
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto flex flex-col gap-2 p-2">
          {pendingEdits.map((edit) => (
            <div key={`pending-${edit.id}`} ref={registerSection(edit.path)}>
              <PendingEditSection
                conversationId={conversationId}
                edit={edit}
              />
            </div>
          ))}
          {appliedEntries.map((entry) => (
            <div key={entry.path} ref={registerSection(entry.path)}>
              <AppliedFileSection
                conversationId={conversationId}
                projectPath={projectPath}
                entry={entry}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                             Shared hunk helpers                            */
/* -------------------------------------------------------------------------- */

/**
 * Hunks for a (before, after) pair. `before === null` means a brand-new
 * file: synthesize one whole-file hunk so the same Keep/Undo UI applies.
 */
function hunksFor(before: string | null, after: string): Hunk[] {
  if (before === null) {
    const newLines = after.split("\n");
    if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
      newLines.pop();
    }
    if (newLines.length === 0) return [];
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
  return parseHunks(before, after);
}

/** Pre-computed interleaved rows per hunk, with the cumulative NEW-file
 * line offset so gutters stay consistent across isolated hunks, and the
 * highlight language disabled above MAX_HIGHLIGHT_ROWS. */
function useHunkRows(hunks: Hunk[], filePath: string) {
  return useMemo(() => {
    const language = languageForPath(filePath);
    const perHunk: DiffRow[][] = [];
    let delta = 0;
    let totalRows = 0;
    for (const hunk of hunks) {
      const rows = buildHunkRows(hunk, delta);
      delta += hunk.newLines.length - hunk.originalLines.length;
      totalRows += rows.length;
      perHunk.push(rows);
    }
    const rowLanguage = totalRows > MAX_HIGHLIGHT_ROWS ? undefined : language;
    return { perHunk, rowLanguage };
  }, [hunks, filePath]);
}

function hunkCounts(hunks: Hunk[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const h of hunks) {
    adds += h.newLines.length;
    dels += h.originalLines.length;
  }
  return { adds, dels };
}

function HunkRows({
  rows,
  language,
  filePath,
  conversationId,
}: {
  rows: DiffRow[];
  language?: string;
  filePath: string;
  conversationId: string;
}) {
  return (
    <div className="border-t border-bg-border overflow-x-auto bg-bg-primary">
      {rows.map((row) => (
        <CommentableRow
          key={row.key}
          row={row}
          language={language}
          filePath={filePath}
          conversationId={conversationId}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Pending edit section                            */
/* -------------------------------------------------------------------------- */

/**
 * A gated edit awaiting decision. Per-hunk Keep/Undo toggles select which
 * hunks land; the file-level actions are the ONLY way anything applies:
 *
 *  - Keep    → respondEdit "apply" (with `applyAcceptedHunks` merged content
 *              when a strict subset of hunks is kept)
 *  - Undo    → respondEdit "reject" (also what Keep degrades to when every
 *              hunk is un-kept, so the model is told the truth)
 */
function PendingEditSection({
  conversationId,
  edit,
}: {
  conversationId: string;
  edit: PendingEdit;
}) {
  const respondEdit = useAgentApprovalStore((s) => s.respondEdit);
  const before = edit.before === undefined ? null : edit.before;
  const isNewFile = before === null;

  const hunks = useMemo(() => hunksFor(before, edit.content), [before, edit.content]);
  const [keptIds, setKeptIds] = useState<Set<string>>(
    () => new Set(hunks.map((h) => h.id)),
  );
  useEffect(() => {
    setKeptIds(new Set(hunks.map((h) => h.id)));
  }, [hunks]);

  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { perHunk, rowLanguage } = useHunkRows(hunks, edit.path);
  const { adds, dels } = hunkCounts(hunks);

  const toggleHunk = (id: string) => {
    setKeptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  async function respond(decision: "keep" | "undo") {
    if (responding) return;
    setResponding(true);
    setError(null);
    try {
      if (decision === "undo" || keptIds.size === 0) {
        await respondEdit(conversationId, edit.id, "reject");
      } else if (keptIds.size === hunks.length || before === null) {
        await respondEdit(conversationId, edit.id, "apply");
      } else {
        await respondEdit(
          conversationId,
          edit.id,
          "apply",
          applyAcceptedHunks(before, hunks, keptIds),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResponding(false);
    }
  }

  const partial = keptIds.size > 0 && keptIds.size < hunks.length;

  return (
    <div className="rounded border border-accent-amber/40 bg-bg-secondary overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-bg-secondary">
        {isNewFile ? (
          <FilePlus2 size={12} className="text-accent-green shrink-0" />
        ) : (
          <FileDiff size={12} className="text-accent-amber shrink-0" />
        )}
        <span
          className="text-[11px] font-mono text-text-primary truncate flex-1"
          title={edit.path}
        >
          {edit.path}
        </span>
        <span className="flex items-center gap-1 text-[10px] font-mono shrink-0">
          <span className="text-accent-green">+{adds}</span>
          <span className="text-accent-red">-{dels}</span>
        </span>
        <span className="text-[9px] text-accent-amber shrink-0">
          awaiting review
        </span>
      </div>

      {error && (
        <div className="px-2 py-1 text-[10px] text-accent-red bg-accent-red/10 border-t border-bg-border">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1.5 p-1.5 border-t border-bg-border">
        {hunks.map((hunk, idx) => {
          const kept = keptIds.has(hunk.id);
          return (
            <div
              key={hunk.id}
              className={`rounded border transition-colors ${
                kept
                  ? "border-accent-green/40"
                  : "border-bg-border opacity-60"
              }`}
            >
              <button
                type="button"
                onClick={() => toggleHunk(hunk.id)}
                role="checkbox"
                aria-checked={kept}
                aria-label={`Keep hunk ${idx + 1} at line ${hunk.startLine}`}
                className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-bg-hover transition-colors"
                title={kept ? "Undo this hunk" : "Keep this hunk"}
              >
                {kept ? (
                  <CheckSquare size={12} className="text-accent-green shrink-0" />
                ) : (
                  <Square size={12} className="text-text-secondary shrink-0" />
                )}
                <span className="text-[10px] font-mono text-text-secondary">
                  Hunk {idx + 1} @ line {hunk.startLine}
                </span>
                <span className="ml-auto text-[10px] font-mono">
                  <span className="text-accent-green">
                    +{hunk.newLines.length}
                  </span>{" "}
                  <span className="text-accent-red">
                    -{hunk.originalLines.length}
                  </span>
                </span>
              </button>
              <HunkRows
                rows={perHunk[idx]}
                language={rowLanguage}
                filePath={edit.path}
                conversationId={conversationId}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-bg-border bg-bg-primary">
        <button
          type="button"
          onClick={() => void respond("keep")}
          disabled={responding}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-accent-green/20 hover:bg-accent-green/30 text-accent-green font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {responding ? <Spinner size={11} /> : <CheckSquare size={12} />}
          {partial ? `Keep ${keptIds.size}/${hunks.length}` : "Keep"}
        </button>
        <button
          type="button"
          onClick={() => void respond("undo")}
          disabled={responding}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-accent-red/15 hover:bg-accent-red/25 text-accent-red font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Undo2 size={12} /> Undo all
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Applied file section                            */
/* -------------------------------------------------------------------------- */

/**
 * An already-applied (or auto-applied) file, diffed baseline → disk when a
 * recorded baseline exists so the diff stays truthful after apply. Per-hunk
 * Undo restores the baseline lines for that hunk on disk; the Viewed
 * checkbox persists the acknowledged edit signature and collapses the body.
 *
 * Without a recorded baseline (legacy session / app restart) the section
 * degrades to a read-only preview of disk → proposed content, the pre-P1-7
 * fallback.
 */
function AppliedFileSection({
  conversationId,
  projectPath,
  entry,
}: {
  conversationId: string;
  projectPath: string;
  entry: WriteFileEntry;
}) {
  // Selector must return a stable primitive (a fresh object every snapshot
  // would re-render forever). `undefined` = no baseline recorded; `null` =
  // recorded as "file did not exist" (Map.get can't produce undefined here
  // because stored values are `string | null`).
  const baselineContent = useEditBaselineStore((s) =>
    s.byConversation.get(conversationId)?.get(entry.path),
  );
  const baseline = useMemo(
    () =>
      baselineContent === undefined
        ? undefined
        : { content: baselineContent },
    [baselineContent],
  );
  const { state: disk, refresh } = useFileDisk(projectPath || undefined, entry.path);

  const signature = editSignature(entry);
  const viewed = useReviewStore(
    (s) => s.viewed[conversationId]?.[entry.path] === signature,
  );
  const setViewed = useReviewStore((s) => s.setViewed);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the (before, after) pair for the hunk engine.
  const resolved = useMemo(() => {
    if (disk.kind === "loading" || disk.kind === "error") return null;
    const diskContent = disk.kind === "existing" ? disk.oldContent : null;
    if (baseline !== undefined) {
      // Truthful post-hoc pair: recorded baseline → what's on disk now.
      return {
        before: baseline.content,
        after: diskContent ?? "",
        undoable: baseline.content !== null && diskContent !== null,
      };
    }
    // Legacy fallback: disk → proposed transcript content, read-only.
    return { before: diskContent, after: entry.content, undoable: false };
  }, [disk, baseline, entry.content]);

  const hunks = useMemo(
    () => (resolved ? hunksFor(resolved.before, resolved.after) : []),
    [resolved],
  );
  const { perHunk, rowLanguage } = useHunkRows(hunks, entry.path);
  const { adds, dels } = hunkCounts(hunks);
  const isNewFile = resolved?.before === null;

  /**
   * Revert `idsToUndo` on disk: rebuild the file from the baseline keeping
   * every OTHER hunk (applyAcceptedHunks reconstructs disk exactly when all
   * hunks are accepted, so dropping one restores just that region).
   */
  async function undoHunks(idsToUndo: Set<string>) {
    if (!resolved || resolved.before === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const keep = new Set(
        hunks.filter((h) => !idsToUndo.has(h.id)).map((h) => h.id),
      );
      const next = applyAcceptedHunks(resolved.before, hunks, keep);
      await writeFileContents(
        joinAbsolutePath(projectPath, entry.path),
        projectPath,
        next,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const undoable = resolved?.undoable === true && hunks.length > 0;

  return (
    <div
      className={`rounded border border-bg-border bg-bg-secondary overflow-hidden ${
        viewed ? "opacity-70" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        {isNewFile ? (
          <FilePlus2 size={12} className="text-accent-green shrink-0" />
        ) : (
          <FileDiff size={12} className="text-text-secondary shrink-0" />
        )}
        <span
          className="text-[11px] font-mono text-text-primary truncate flex-1"
          title={entry.path}
        >
          {entry.path}
        </span>
        {isNewFile && (
          <span className="text-[9px] text-accent-green border border-accent-green/30 bg-accent-green/10 px-1 rounded shrink-0">
            new
          </span>
        )}
        <span className="flex items-center gap-1 text-[10px] font-mono shrink-0">
          <span className="text-accent-green">+{adds}</span>
          <span className="text-accent-red">-{dels}</span>
        </span>
        {undoable && (
          <Tooltip content="Restore this file to its pre-edit content">
            <button
              type="button"
              onClick={() => void undoHunks(new Set(hunks.map((h) => h.id)))}
              disabled={busy}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover hover:text-accent-red transition-colors disabled:opacity-50"
            >
              <Undo2 size={10} /> Undo all
            </button>
          </Tooltip>
        )}
        <label className="flex items-center gap-1 text-[10px] text-text-secondary cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) =>
              setViewed(conversationId, entry.path, signature, e.target.checked)
            }
            aria-label={`Viewed ${entry.path}`}
          />
          Viewed
        </label>
      </div>

      {error && (
        <div className="px-2 py-1 text-[10px] text-accent-red bg-accent-red/10 border-t border-bg-border">
          {error}
        </div>
      )}

      {!viewed && (
        <div className="border-t border-bg-border">
          {disk.kind === "loading" ? (
            <div className="px-3 py-3 flex items-center gap-1.5 text-[11px] text-text-secondary">
              <Spinner size={12} className="text-text-muted" />
              Loading file from disk…
            </div>
          ) : disk.kind === "error" ? (
            <div className="px-3 py-3 text-[11px] text-accent-red flex items-center gap-2">
              <AlertCircle size={12} />
              Could not read this file from disk.
            </div>
          ) : hunks.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-text-muted italic">
              No changes vs. on-disk content.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 p-1.5">
              {hunks.map((hunk, idx) => (
                <div key={hunk.id} className="rounded border border-bg-border">
                  <div className="flex items-center gap-2 px-2 py-1">
                    <span className="text-[10px] font-mono text-text-secondary">
                      Hunk {idx + 1} @ line {hunk.startLine}
                    </span>
                    <span className="ml-auto text-[10px] font-mono">
                      <span className="text-accent-green">
                        +{hunk.newLines.length}
                      </span>{" "}
                      <span className="text-accent-red">
                        -{hunk.originalLines.length}
                      </span>
                    </span>
                    {undoable && (
                      <Tooltip content="Restore the original lines for this hunk">
                        <button
                          type="button"
                          onClick={() => void undoHunks(new Set([hunk.id]))}
                          disabled={busy}
                          className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-bg-border text-text-secondary hover:bg-bg-hover hover:text-accent-red transition-colors disabled:opacity-50"
                        >
                          <Undo2 size={10} /> Undo
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <HunkRows
                    rows={perHunk[idx]}
                    language={rowLanguage}
                    filePath={entry.path}
                    conversationId={conversationId}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
