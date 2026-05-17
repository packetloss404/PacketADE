import { Ban } from "lucide-react";
import type { AgentConversation } from "@/types/agent-conversation";

interface CancelPendingButtonProps {
  conversation: AgentConversation;
  onCancel: () => void;
}

/**
 * Drains parked tool/edit prompts as denied so the agent loop can continue.
 * Distinct from Stop, which kills the whole turn.
 */
export function CancelPendingButton({
  conversation,
  onCancel,
}: CancelPendingButtonProps) {
  const pendingCount =
    (conversation.pendingEdits?.length ?? 0) +
    (conversation.pendingPermissions?.length ?? 0);
  if (pendingCount === 0) return null;
  return (
    <button
      onClick={onCancel}
      className="inline-flex items-center gap-1 px-1.5 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-secondary rounded transition-colors shrink-0"
      title={`Drain ${pendingCount} parked prompt${pendingCount === 1 ? "" : "s"} as denied — agent loop continues`}
    >
      <Ban size={11} />
      <span>
        Cancel {pendingCount}
      </span>
    </button>
  );
}
