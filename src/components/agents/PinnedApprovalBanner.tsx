import { useMemo } from "react";
import { ShieldAlert } from "lucide-react";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { openConversationInAgents } from "@/stores/sessionGlue";

/**
 * P1-9: pin approvals that scroll out of view. A blocking permission prompt
 * is only visible while its conversation's tile is on screen and scrolled to —
 * scroll away or focus another tile and the prompt vanishes while the agent
 * sits blocked. The OS-notification layer pings once (pref-gated, debounced,
 * often focus-suppressed); this banner is the in-app half of that story: it
 * stays pinned at the viewport edge until every waiting prompt is answered, and
 * jumps straight to the blocked conversation's tile.
 */
export function PinnedApprovalBanner() {
  const permissions = useAgentApprovalStore((s) => s.permissions);
  const edits = useAgentApprovalStore((s) => s.edits);
  const conversations = useAgentTaskStore((s) => s.conversations);

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
    const entries: { conversationId: string; title: string; count: number }[] = [];
    for (const [conversationId, count] of waiting) {
      const conv = conversations.find((c) => c.id === conversationId);
      entries.push({
        conversationId,
        title: conv?.title || "Agent",
        count,
      });
    }
    return entries;
  }, [permissions, edits, conversations]);

  if (outOfView.length === 0) return null;

  const first = outOfView[0];
  const totalCount = outOfView.reduce((sum, e) => sum + e.count, 0);
  const moreConversations = outOfView.length - 1;

  const jump = () => {
    openConversationInAgents(first.conversationId);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-accent-amber/50 fixed bottom-8 right-4 z-40 flex max-w-[380px] animate-[welcomeFadeIn_150ms_ease-out] items-center gap-2 rounded border bg-bg-elevated px-3 py-2 shadow-lg motion-reduce:animate-none"
    >
      <ShieldAlert size={14} className="shrink-0 text-accent-amber" />
      <span className="min-w-0 flex-1 text-ui text-text-primary">
        <span className="font-medium">
          {totalCount} approval{totalCount === 1 ? "" : "s"} waiting
        </span>{" "}
        <span className="truncate text-text-secondary">
          · {first.title}
          {moreConversations > 0 && ` +${moreConversations} more`}
        </span>
      </span>
      <button
        type="button"
        onClick={jump}
        className="bg-accent-amber/15 hover:bg-accent-amber/25 shrink-0 rounded px-2 py-1 text-ui font-medium text-accent-amber transition-colors"
      >
        Review
      </button>
    </div>
  );
}
