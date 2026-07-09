import { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAppStore } from "@/stores/appStore";
import { focusConversationDeepLink } from "@/stores/sessionGlue";

/**
 * P1-9: pin approvals that scroll out of view. A blocking permission prompt
 * is only visible while its conversation is the selected one in the Agents
 * view — navigate anywhere else (another conversation, another tab) and the
 * prompt vanishes while the agent sits blocked. The OS-notification layer
 * pings once (pref-gated, debounced, often focus-suppressed); this banner is
 * the in-app half of that story: it stays pinned at the viewport edge until
 * every out-of-view prompt is answered, and jumps straight to the blocked
 * conversation.
 *
 * Prompts for the conversation currently on screen are excluded — those are
 * already pinned above the composer by PendingApprovalsSection.
 */
export function PinnedApprovalBanner() {
  const permissions = useAgentApprovalStore((s) => s.permissions);
  const edits = useAgentApprovalStore((s) => s.edits);
  const conversations = useAgentTaskStore((s) => s.conversations);
  const selectedConversationId = useAgentTaskStore(
    (s) => s.selectedConversationId,
  );
  const activeView = useAppStore((s) => s.activeView);

  const outOfView = useMemo(() => {
    // Both blocking queues count: permission prompts AND gated pending
    // edits (approve-writes on) — the agent sits blocked on respondEdit
    // just as hard as on respondPermission.
    const waiting = new Map<string, number>();
    for (const [conversationId, queue] of permissions) {
      if (queue.length === 0) continue;
      waiting.set(conversationId, queue.length);
    }
    for (const [conversationId, queue] of edits) {
      if (queue.length === 0) continue;
      waiting.set(conversationId, (waiting.get(conversationId) ?? 0) + queue.length);
    }
    const entries: { conversationId: string; title: string; count: number }[] =
      [];
    for (const [conversationId, count] of waiting) {
      // The selected Agents-view conversation renders its own pinned
      // surfaces (PendingApprovalsSection footer + ReviewBar) — no second
      // banner for it.
      const onScreen =
        activeView === "agents" && selectedConversationId === conversationId;
      if (onScreen) continue;
      const conv = conversations.find((c) => c.id === conversationId);
      entries.push({
        conversationId,
        title: conv?.title || "Agent",
        count,
      });
    }
    return entries;
  }, [permissions, edits, conversations, activeView, selectedConversationId]);

  if (outOfView.length === 0) return null;

  const first = outOfView[0];
  const totalCount = outOfView.reduce((sum, e) => sum + e.count, 0);
  const moreConversations = outOfView.length - 1;

  // Tile program (P5-S1): retargeted from setActiveView("agents") to the
  // materializing deep-link path — the blocked conversation lands on its
  // focused+flashed workspace tile with the pending approval visible.
  const jump = () => {
    focusConversationDeepLink(first.conversationId);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-8 right-4 z-40 flex items-center gap-2 max-w-[380px] px-3 py-2 rounded border border-accent-amber/50 bg-bg-elevated shadow-lg animate-[welcomeFadeIn_150ms_ease-out] motion-reduce:animate-none"
    >
      <ShieldAlert size={14} className="text-accent-amber shrink-0" />
      <span className="min-w-0 flex-1 text-ui text-text-primary">
        <span className="font-medium">
          {totalCount} approval{totalCount === 1 ? "" : "s"} waiting
        </span>{" "}
        <span className="text-text-secondary truncate">
          · {first.title}
          {moreConversations > 0 && ` +${moreConversations} more`}
        </span>
      </span>
      <button
        type="button"
        onClick={jump}
        className="shrink-0 text-ui px-2 py-1 rounded bg-accent-amber/15 hover:bg-accent-amber/25 text-accent-amber font-medium transition-colors"
      >
        Review
      </button>
    </div>
  );
}
