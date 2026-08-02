import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  FileEdit,
  GitMerge,
  Loader2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import {
  githubClosePr,
  githubMergePr,
  githubReopenPr,
  githubSetPrDraftState,
  type GitHubMergeMethod,
} from "@/lib/tauri";
import { useGitHubStore } from "@/stores/githubStore";
import type { GitHubPr } from "@/types/github";

/**
 * v0.8-A — PR lifecycle action bar. Renders under the PR title row in the
 * detail panel. Buttons shown depend on PR state:
 *
 * - open + not draft → Merge (primary), Close, Convert to draft
 * - open + draft     → Ready for review, Close
 * - closed (unmerged)→ Reopen
 * - merged           → green "Merged" pill, no actions
 *
 * Each click triggers a small inline confirm step before invoking the
 * backend. On success we call `onAction()` so the parent can refetch the PR
 * list, and we patch the store optimistically so the UI reflects the new
 * state before the network round-trip lands.
 */

interface Props {
  pr: GitHubPr;
  /** Called after a successful action — triggers a refetch in the parent. */
  onAction: () => void;
  allowDraftToggle?: boolean;
}

type ActionKind = "merge" | "close" | "reopen" | "to-draft" | "ready";
type Status =
  | { kind: "idle" }
  | { kind: "confirming"; action: ActionKind; mergeMethod?: GitHubMergeMethod }
  | { kind: "running"; action: ActionKind }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/** Detect "merged" state. The list endpoint doesn't return `merged`, so we
 *  fall back to `merged_at` (PR detail) or state==="closed" + merged_at. */
function isMerged(pr: GitHubPr): boolean {
  if (pr.merged === true) return true;
  if (pr.merged_at) return true;
  return false;
}

export function PRActionBar({ pr, onAction, allowDraftToggle = true }: Props) {
  const { config, updatePrState } = useGitHubStore();
  // v0.8: pre-seed the merge dropdown with the user's persisted default. We
  // pull from the store snapshot (not a live subscription) so the local
  // dropdown choice can drift from the global default within a session
  // without thrashing on Settings tweaks.
  const defaultMergeStrategy = useGitHubStore((s) => s.defaultMergeStrategy);
  const requireMergeConfirmation = useGitHubStore((s) => s.requireMergeConfirmation);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [mergeMethod, setMergeMethod] = useState<GitHubMergeMethod>(defaultMergeStrategy);
  const [showMergeMenu, setShowMergeMenu] = useState(false);

  const merged = isMerged(pr);
  const isClosed = pr.state === "closed";
  const isOpen = pr.state === "open" && !merged;
  const isDraft = !!pr.draft;

  if (merged) {
    return (
      <div className="bg-bg-secondary/60 flex items-center gap-2 border-b border-bg-border px-3 py-2">
        <span className="bg-accent-green/15 border-accent-green/30 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold text-accent-green">
          <CheckCircle2 size={12} />
          Merged
        </span>
        <span className="text-[10px] text-text-muted">This pull request has been merged.</span>
      </div>
    );
  }

  const repo = config.selectedRepo;

  async function run(action: ActionKind, method?: GitHubMergeMethod) {
    if (!repo) {
      setStatus({ kind: "error", message: "No repository selected." });
      return;
    }
    const expectedConnectionId = useGitHubStore.getState().activeConnectionId;
    const stillCurrent = () => {
      const current = useGitHubStore.getState();
      return (
        current.activeConnectionId === expectedConnectionId &&
        current.config.selectedRepo?.owner === repo.owner &&
        current.config.selectedRepo?.repo === repo.repo
      );
    };
    setStatus({ kind: "running", action });
    try {
      if (action === "merge") {
        const chosen = method ?? mergeMethod;
        const result = await githubMergePr(repo.owner, repo.repo, pr.number, chosen);
        if (!stillCurrent()) return;
        updatePrState(pr.number, {
          state: "closed",
          merged: true,
          merged_at: new Date().toISOString(),
        });
        setStatus({
          kind: "success",
          message: `Merged (${chosen}) — ${result.sha.slice(0, 7)}`,
        });
      } else if (action === "close") {
        await githubClosePr(repo.owner, repo.repo, pr.number);
        if (!stillCurrent()) return;
        updatePrState(pr.number, { state: "closed" });
        setStatus({ kind: "success", message: "Closed." });
      } else if (action === "reopen") {
        await githubReopenPr(repo.owner, repo.repo, pr.number);
        if (!stillCurrent()) return;
        updatePrState(pr.number, { state: "open" });
        setStatus({ kind: "success", message: "Reopened." });
      } else if (action === "to-draft") {
        const next = await githubSetPrDraftState(repo.owner, repo.repo, pr.number, true);
        if (!stillCurrent()) return;
        updatePrState(pr.number, { draft: next });
        setStatus({ kind: "success", message: "Converted to draft." });
      } else if (action === "ready") {
        const next = await githubSetPrDraftState(repo.owner, repo.repo, pr.number, false);
        if (!stillCurrent()) return;
        updatePrState(pr.number, { draft: next });
        setStatus({ kind: "success", message: "Marked ready for review." });
      }
      onAction();
    } catch (e) {
      if (!stillCurrent()) return;
      setStatus({ kind: "error", message: String(e) });
    }
  }

  function startConfirm(action: ActionKind, method?: GitHubMergeMethod) {
    setShowMergeMenu(false);
    if (method) setMergeMethod(method);
    // v0.8: Settings → GitHub lets power-users opt out of the inline
    // confirm step for merge/close/convert-to-draft. "reopen" and "ready"
    // are non-destructive but we route them through the same guard for
    // consistency — they're cheap if the user happened to mis-click.
    if (!requireMergeConfirmation) {
      void run(action, method);
      return;
    }
    setStatus({ kind: "confirming", action, mergeMethod: method });
  }

  function cancelConfirm() {
    setStatus({ kind: "idle" });
  }

  const isRunning = status.kind === "running";

  return (
    <div className="bg-bg-secondary/60 flex flex-col gap-2 border-b border-bg-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {isOpen && !isDraft && (
          <>
            {/* Merge — primary CTA with strategy dropdown */}
            <div className="relative inline-flex">
              <button
                type="button"
                onClick={() => startConfirm("merge", mergeMethod)}
                disabled={isRunning}
                className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 inline-flex items-center gap-1.5 rounded-l border px-2.5 py-1 text-[10.5px] font-semibold text-accent-green transition-colors disabled:opacity-50"
              >
                {isRunning && status.action === "merge" ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <GitMerge size={10} />
                )}
                Merge ({mergeMethod})
              </button>
              <button
                type="button"
                onClick={() => setShowMergeMenu((v) => !v)}
                disabled={isRunning}
                aria-label="Choose merge strategy"
                className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 inline-flex items-center rounded-r border border-l-0 px-1.5 py-1 text-[10.5px] font-semibold text-accent-green transition-colors disabled:opacity-50"
              >
                <ChevronDown size={10} />
              </button>
              {showMergeMenu && (
                <div className="absolute left-0 top-full z-10 mt-1 min-w-[140px] rounded border border-bg-border bg-bg-secondary shadow-lg">
                  {(["merge", "squash", "rebase"] as GitHubMergeMethod[]).map((m) => (
                    <button
                      type="button"
                      key={m}
                      onClick={() => {
                        setMergeMethod(m);
                        setShowMergeMenu(false);
                      }}
                      className={`w-full px-2.5 py-1.5 text-left text-[10.5px] transition-colors hover:bg-bg-tertiary ${
                        m === mergeMethod ? "text-accent-green" : "text-text-secondary"
                      }`}
                    >
                      {m === "merge"
                        ? "Create a merge commit"
                        : m === "squash"
                          ? "Squash and merge"
                          : "Rebase and merge"}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => startConfirm("close")}
              disabled={isRunning}
              className="hover:bg-accent-red/10 hover:border-accent-red/30 inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-tertiary px-2.5 py-1 text-[10.5px] font-medium text-text-secondary transition-colors hover:text-accent-red disabled:opacity-50"
            >
              <XCircle size={10} /> Close
            </button>

            {allowDraftToggle && (
              <button
                type="button"
                onClick={() => startConfirm("to-draft")}
                disabled={isRunning}
                className="hover:bg-bg-tertiary/80 inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-tertiary px-2.5 py-1 text-[10.5px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <FileEdit size={10} /> Convert to draft
              </button>
            )}
          </>
        )}

        {isOpen && isDraft && (
          <>
            {allowDraftToggle && (
              <button
                type="button"
                onClick={() => startConfirm("ready")}
                disabled={isRunning}
                className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10.5px] font-semibold text-accent-green transition-colors disabled:opacity-50"
              >
                {isRunning && status.action === "ready" ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={10} />
                )}
                Ready for review
              </button>
            )}
            <button
              type="button"
              onClick={() => startConfirm("close")}
              disabled={isRunning}
              className="hover:bg-accent-red/10 hover:border-accent-red/30 inline-flex items-center gap-1.5 rounded border border-bg-border bg-bg-tertiary px-2.5 py-1 text-[10.5px] font-medium text-text-secondary transition-colors hover:text-accent-red disabled:opacity-50"
            >
              <XCircle size={10} /> Close
            </button>
          </>
        )}

        {isClosed && (
          <button
            type="button"
            onClick={() => startConfirm("reopen")}
            disabled={isRunning}
            className="bg-accent-blue/15 border-accent-blue/30 hover:bg-accent-blue/25 inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10.5px] font-medium text-accent-blue transition-colors disabled:opacity-50"
          >
            {isRunning && status.action === "reopen" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <RotateCcw size={10} />
            )}
            Reopen
          </button>
        )}
      </div>

      {status.kind === "confirming" && (
        <div className="flex items-center gap-1.5 rounded border border-bg-border bg-bg-tertiary px-2 py-1.5 text-[10.5px]">
          <span className="flex-1 text-text-secondary">
            {confirmCopy(status.action, status.mergeMethod ?? mergeMethod)}
          </span>
          <button
            type="button"
            onClick={() => run(status.action, status.mergeMethod)}
            className="bg-accent-green/15 border-accent-green/30 hover:bg-accent-green/25 rounded border px-2 py-0.5 text-[10px] font-medium text-accent-green transition-colors"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={cancelConfirm}
            className="px-2 py-0.5 text-[10px] font-medium text-text-muted transition-colors hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      )}

      {status.kind === "success" && (
        <div className="flex items-center gap-1.5 text-[10px] text-accent-green">
          <CheckCircle2 size={10} />
          <span className="flex-1">{status.message}</span>
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="text-text-muted hover:text-text-primary"
          >
            dismiss
          </button>
        </div>
      )}

      {status.kind === "error" && (
        <div className="flex items-center gap-1.5 text-[10px] text-accent-red">
          <XCircle size={10} />
          <span className="flex-1">{status.message}</span>
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="text-text-muted hover:text-text-primary"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function confirmCopy(action: ActionKind, method: GitHubMergeMethod): string {
  switch (action) {
    case "merge":
      return `Merge this PR via ${method}? This will close the PR and write to the base branch.`;
    case "close":
      return "Close this PR without merging?";
    case "reopen":
      return "Reopen this PR?";
    case "to-draft":
      return "Convert this PR to draft? Reviewers won't be auto-pinged.";
    case "ready":
      return "Mark this PR ready for review?";
  }
}
