import { FileDiff } from "lucide-react";
import { useReviewStore } from "@/stores/reviewStore";

interface DiffPaneTriggerProps {
  conversationId: string;
  totalAdds: number;
  totalDels: number;
  fileCount: number;
}

/**
 * Compact inline chip rendered in the AgentChatPane header (or per-turn).
 * Shows aggregate `+N -M` and the affected file count; click expands the
 * canonical review surface scoped to this conversation.
 */
export function DiffPaneTrigger({
  conversationId,
  totalAdds,
  totalDels,
  fileCount,
}: DiffPaneTriggerProps) {
  const openForConversation = useReviewStore(
    (s) => s.openForConversation,
  );

  if (fileCount === 0) return null;

  return (
    <button
      type="button"
      onClick={() => openForConversation(conversationId)}
      title={`View ${fileCount} file change${fileCount === 1 ? "" : "s"}`}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-bg-border bg-bg-tertiary hover:bg-bg-border hover:text-text-primary transition-colors text-[10px] font-mono"
    >
      <FileDiff size={10} className="text-text-secondary" />
      <span className="text-text-secondary">
        {fileCount} file{fileCount === 1 ? "" : "s"}
      </span>
      <span className="text-accent-green">+{totalAdds}</span>
      <span className="text-accent-red">-{totalDels}</span>
    </button>
  );
}
