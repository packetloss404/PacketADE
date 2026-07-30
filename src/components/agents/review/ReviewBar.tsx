import { useEffect } from "react";
import { ChevronUp, FileDiff, GitMerge } from "lucide-react";
import { useReviewStore } from "@/stores/reviewStore";
import { useAppStore } from "@/stores/appStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { openConversationGitEnding } from "@/lib/agentHandoffs";
import {
  countReviewFiles,
  type DiffTotals,
} from "@/components/agents/hooks/useDiffTotals";
import type { PendingEdit } from "@/types/agent-conversation";
import type { useAgentApprovalStore } from "@/stores/agentApprovalStore";

type ApprovalStore = ReturnType<typeof useAgentApprovalStore.getState>;

export interface ReviewBarProps {
  conversationId: string;
  /** Aggregate totals from `useDiffTotals` (computed once by the pane). */
  diffTotals: DiffTotals;
  pendingEdits: PendingEdit[];
  /** Pending permission prompts outrank edits for the Y/N shortcut — when
   * any exist, PendingApprovalsSection owns the keys and this bar stays
   * passive. */
  pendingPermissionCount: number;
  respondEdit: ApprovalStore["respondEdit"];
  /**
   * Y/N focus gate (P3-S1). Undefined → no pane context (standalone
   * AgentsView), armed exactly as today. Defined → armed iff true, so only
   * the focused conversation tile's bar answers a keypress. Extends the
   * existing arming condition; never alters the standalone path.
   */
  keyboardScopeActive?: boolean;
}

/**
 * The persistent "N files · +X/−Y · Review" bar above the composer
 * (consensus P1-8). Expands into the canonical multibuffer ReviewSurface.
 * Turns amber while gated edits await review, and carries the protected
 * Y/N keyboard approvals for the top pending edit (Y = keep everything via
 * respondEdit "apply", N = undo via respondEdit "reject") with the same
 * typing-context guards the approvals section uses.
 */
export function ReviewBar({
  conversationId,
  diffTotals,
  pendingEdits,
  pendingPermissionCount,
  respondEdit,
  keyboardScopeActive,
}: ReviewBarProps) {
  const open = useReviewStore(
    (s) => s.open && s.conversationId === conversationId,
  );
  const openForConversation = useReviewStore((s) => s.openForConversation);
  const close = useReviewStore((s) => s.close);

  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);

  // The additive "Finish → Commit…" CTA. Shown when the session has settled
  // (done/idle) with reviewed changes (files present, nothing still awaiting a
  // Y/N). The WA3 handoff opens the ONE endings surface —
  // GitDashboard's WorktreeLifecycleBar — against this exact conversation and
  // worktree. From Agents it explicitly attaches the same conversation ID to a
  // matching Workspace; from a compatibility tile it reuses that placement.
  const conversationStatus = useAgentTaskStore(
    (s) => s.conversations.find((c) => c.id === conversationId)?.status,
  );
  const topEdit = pendingEdits[0];
  // Dual-mode focus gate (P3-S1): no pane context (undefined) → armed as
  // today; pane context → armed iff this instance holds keyboard scope.
  const scopeArmed = keyboardScopeActive === undefined || keyboardScopeActive;
  const ynActive = !!topEdit && pendingPermissionCount === 0 && scopeArmed;

  useEffect(() => {
    if (!ynActive || commandPaletteOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      const key = e.key.toLowerCase();
      if (key !== "y" && key !== "n") return;
      e.preventDefault();
      if (key === "y") {
        void respondEdit(conversationId, topEdit.id, "apply");
      } else {
        void respondEdit(conversationId, topEdit.id, "reject");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ynActive, commandPaletteOpen, conversationId, topEdit, respondEdit]);

  // Gated files usually already count in the aggregate (their tool call is
  // in the transcript pre-approval) — union, never sum, or one file shows
  // as 2.
  const fileCount = countReviewFiles(diffTotals, pendingEdits);
  if (fileCount === 0) return null;

  const hasPending = pendingEdits.length > 0;
  // Reviewed changes on a settled session ⇒ offer the endings loop.
  const settled = conversationStatus === "done" || conversationStatus === "idle";
  const showFinish = settled && !hasPending;

  return (
    <div
      className={`shrink-0 border-t px-3 py-1.5 ${
        hasPending
          ? "border-accent-amber/40 bg-accent-amber/5"
          : "border-bg-border bg-bg-primary"
      }`}
    >
      <button
        type="button"
        onClick={() =>
          open ? close() : openForConversation(conversationId)
        }
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left rounded px-1 py-0.5 hover:bg-bg-hover transition-colors"
        title={open ? "Collapse the review panel" : "Review every change in this conversation"}
      >
        <FileDiff
          size={12}
          className={hasPending ? "text-accent-amber" : "text-text-secondary"}
        />
        <span className="text-ui font-mono text-text-secondary">
          {fileCount} file{fileCount === 1 ? "" : "s"}
          <span className="text-accent-green ml-1.5">
            +{diffTotals.totalAdds}
          </span>
          <span className="text-accent-red ml-1">-{diffTotals.totalDels}</span>
        </span>
        {hasPending && (
          <span className="text-meta text-accent-amber">
            {pendingEdits.length} awaiting review
            {ynActive && (
              <span className="text-text-muted ml-1.5">
                Y keep · N undo
              </span>
            )}
          </span>
        )}
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-ui font-medium text-text-secondary">
          Review
          <ChevronUp
            size={12}
            className={`transition-transform motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>

      {showFinish && (
        <button
          type="button"
          onClick={() => openConversationGitEnding(conversationId)}
          className="hover:bg-accent-green/10 mt-1 flex w-full items-center justify-center gap-1.5 rounded px-1 py-1 text-ui font-medium text-accent-green transition-colors"
          title="Commit and land this conversation's changes"
        >
          <GitMerge size={12} />
          Finish → Commit…
        </button>
      )}
    </div>
  );
}
