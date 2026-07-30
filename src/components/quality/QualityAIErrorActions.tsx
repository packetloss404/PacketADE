import { useCallback, useState } from "react";
import { Check, Sparkles, Ticket, Wrench } from "lucide-react";
import { useIssueStore } from "@/stores/issueStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { createIssueWorktree } from "@/lib/tauri";
import { getPreferredWorkspaceCli } from "@/lib/workspaceCliDefaults";
import { QualityAIExplanation, type QualityErrorRef } from "./QualityAIExplanation";
import {
  buildQualityIssueBody,
  buildQualityIssueTitle,
  buildWorkspaceHandoffPrompt,
  labelForCheckName,
  type QualityCheckMeta,
} from "./qualityAIHelpers";

/**
 * v0.8.8 quality ai — per-error action trio.
 *
 * Renders the three AI-powered buttons attached to a single parsed error
 * row (q2 owns the row layout; q2 mounts this component once per row):
 *
 *   1. ✨ Explain   — toggle a streaming AI explanation popover below
 *      the row (delegates to `QualityAIExplanation`).
 *   2. 🔧 Fix in Workspace — spin up a worktree-bound preferred CLI
 *      workspace pane seeded with the error context + the originating
 *      check command. Mirrors `sendIssueToWorkspace` so commits get the
 *      auto-trailer treatment.
 *   3. 🎫 File Issue — single-click promote to a backlog issue (the
 *      bulk-select flow lives in the parent — this button covers the
 *      one-at-a-time case).
 *
 * All actions are local (no extra Tauri command surface beyond the AI
 * commands already wired in `lib/tauri.ts` + the existing
 * `create_issue_worktree`). Bulk selection is provided through the
 * sibling `useQualityIssueFiling` hook.
 */

interface Props {
  error: QualityErrorRef;
  /** Snippet of source code lines around the error location (q2 already
   * has this from its parser; we embed it verbatim into the workspace
   * handoff prompt). When omitted we fall back to "see file:line". */
  contextSnippet?: string;
  /** Which check produced the error — drives Issue labels + handoff text. */
  check: QualityCheckMeta;
  /** Workspace project path — falls back to `layoutStore.projectPath`. */
  projectPath?: string;
  /** Invoked by the parent after the workspace handoff so it can close
   * the modal. Optional. */
  onAfterSendToWorkspace?: () => void;
}

type ToastKind = "filed" | "sent" | "error";
interface Toast {
  kind: ToastKind;
  message: string;
}

export function QualityAIErrorActions({
  error,
  contextSnippet,
  check,
  projectPath,
  onAfterSendToWorkspace,
}: Props) {
  const [showExplanation, setShowExplanation] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [filing, setFiling] = useState(false);
  const [sending, setSending] = useState(false);

  // Auto-clear toast after 4s so the row doesn't carry stale status.
  const flashToast = useCallback((t: Toast) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const handleFileIssue = useCallback(() => {
    if (filing) return;
    setFiling(true);
    try {
      const labels = labelForCheckName(check.name);
      const title = buildQualityIssueTitle(check.name, error.message);
      const body = buildQualityIssueBody(error, check, contextSnippet);

      // Register the label if it doesn't exist yet — otherwise the Issue
      // card renders a label pill that's not in the global label set and
      // the filter UI drops it from the picker.
      const issueState = useIssueStore.getState();
      for (const label of labels) {
        if (!issueState.labels.includes(label)) {
          issueState.addLabel(label);
        }
      }

      const issue = useIssueStore.getState().addIssue({
        title,
        description: body,
        status: "backlog",
        priority: "medium",
        labels,
        epic: null,
        acceptanceCriteria: [
          {
            id: `ac-${crypto.randomUUID().slice(0, 6)}`,
            text: `Error no longer appears in \`${check.command}\``,
            checked: false,
          },
        ],
        blockedBy: [],
        blocks: [],
      });

      flashToast({ kind: "filed", message: `Filed ${issue.ticketId}` });
    } catch (e) {
      flashToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setFiling(false);
    }
  }, [filing, check, error, contextSnippet, flashToast]);

  const handleFixInWorkspace = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      const projectRoot =
        projectPath || useLayoutStore.getState().projectPath || "";
      if (!projectRoot) {
        throw new Error("No project path available");
      }

      // First file an Issue so we get a stable ticket id to anchor the
      // worktree to. The worktree's prepare-commit-msg hook will then
      // automatically tag commits with `Fixes #N`, which closes the loop
      // through `issue-watcher:fixed` → Issue moves to `done`.
      const labels = labelForCheckName(check.name);
      const issueState = useIssueStore.getState();
      for (const label of labels) {
        if (!issueState.labels.includes(label)) {
          issueState.addLabel(label);
        }
      }
      const issue = useIssueStore.getState().addIssue({
        title: buildQualityIssueTitle(check.name, error.message),
        description: buildQualityIssueBody(error, check, contextSnippet),
        status: "in_progress",
        priority: "medium",
        labels,
        epic: null,
        acceptanceCriteria: [
          {
            id: `ac-${crypto.randomUUID().slice(0, 6)}`,
            text: `Error no longer appears in \`${check.command}\``,
            checked: false,
          },
        ],
        blockedBy: [],
        blocks: [],
      });

      const ticketNumMatch = issue.ticketId.match(/(\d+)$/);
      const ticketNum = ticketNumMatch ? Number(ticketNumMatch[1]) : NaN;

      // Provision the worktree so commits get auto-tagged. Mirrors the
      // pattern in `sendIssueToWorkspace`. Fallback to the bare project
      // root if worktree creation fails (e.g. non-git project) — the
      // user still gets a working pane.
      let worktreePath = projectRoot;
      if (Number.isFinite(ticketNum) && ticketNum > 0) {
        try {
          worktreePath = await createIssueWorktree(
            issue.id,
            ticketNum,
            issue.title,
            projectRoot,
          );
        } catch (err) {
          console.warn(
            `[QualityAIErrorActions] createIssueWorktree failed for ${issue.ticketId}; ` +
              `falling back to project root — commit auto-trailer will NOT fire.`,
            err,
          );
          worktreePath = projectRoot;
        }
      }

      const wsName = `Quality #${ticketNum}: ${check.name}`.slice(0, 60);
      const initialPrompt = buildWorkspaceHandoffPrompt(error, check, contextSnippet);

      const workspaceId = useWorkspaceStore.getState().createWorkspace(
        wsName,
        [getPreferredWorkspaceCli()],
        worktreePath,
        { prompt: initialPrompt },
      );

      const created = useWorkspaceStore
        .getState()
        .workspaces.find((w) => w.id === workspaceId);
      const paneId = created?.panes[0]?.id;

      useIssueStore.getState().updateIssue(issue.id, {
        workspaceId,
        sessionId: paneId,
        sentToWorkspaceAt: Date.now(),
      });

      useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
      useAppStore.getState().setActiveView("workspace");

      flashToast({
        kind: "sent",
        message: `Sent to workspace (${issue.ticketId})`,
      });
      onAfterSendToWorkspace?.();
    } catch (e) {
      flashToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSending(false);
    }
  }, [sending, projectPath, check, error, contextSnippet, flashToast, onAfterSendToWorkspace]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setShowExplanation((v) => !v)}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
            showExplanation
              ? "bg-accent-purple/20 border-accent-purple/40 text-accent-purple"
              : "bg-bg-secondary border-bg-border text-text-muted hover:text-accent-purple hover:border-accent-purple/30"
          }`}
          title="Explain this error with AI"
        >
          <Sparkles size={10} />
          Explain
        </button>
        <button
          type="button"
          onClick={handleFixInWorkspace}
          disabled={sending}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border bg-bg-secondary border-bg-border text-text-muted hover:text-accent-green hover:border-accent-green/30 transition-colors disabled:opacity-50"
          title="Open a CLI workspace pane seeded with this error"
        >
          <Wrench size={10} />
          {sending ? "Sending…" : "Fix in Workspace"}
        </button>
        <button
          type="button"
          onClick={handleFileIssue}
          disabled={filing}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border bg-bg-secondary border-bg-border text-text-muted hover:text-accent-amber hover:border-accent-amber/30 transition-colors disabled:opacity-50"
          title="File this error as a backlog issue"
        >
          <Ticket size={10} />
          {filing ? "Filing…" : "File Issue"}
        </button>
        {toast && (
          <span
            className={`inline-flex items-center gap-1 text-[10px] ${
              toast.kind === "error" ? "text-accent-red" : "text-accent-green"
            }`}
          >
            {toast.kind !== "error" && <Check size={10} />}
            {toast.message}
          </span>
        )}
      </div>
      {showExplanation && (
        <QualityAIExplanation
          error={error}
          onClose={() => setShowExplanation(false)}
        />
      )}
    </div>
  );
}
