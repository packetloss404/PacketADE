import { X } from "lucide-react";
import type { AgentConversation } from "@/types/agent-conversation";

interface PendingDiffCommentsStripProps {
  conversation: AgentConversation;
  onRemove: (id: string) => void;
  onClear: () => void;
}

/**
 * B1: queued hover-`+` diff comments. Folded into the next user turn as a
 * "File comments:" preamble; cleared on send or via the inline X. Only
 * renders when the queue is non-empty.
 */
export function PendingDiffCommentsStrip({
  conversation,
  onRemove,
  onClear,
}: PendingDiffCommentsStripProps) {
  const comments = conversation.pendingDiffComments ?? [];
  return (
    <div className="shrink-0 border-t border-accent-blue/30 bg-accent-blue/5 px-3 py-1.5 flex items-center gap-2 flex-wrap">
      <span className="text-meta uppercase tracking-wide text-accent-blue">
        {comments.length} file comment
        {comments.length === 1 ? "" : "s"} queued
      </span>
      <span className="text-meta text-text-muted">
        attached on next send
      </span>
      <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
        {comments.map((dc) => (
          <span
            key={dc.id}
            className="inline-flex items-center gap-1 text-meta bg-bg-secondary rounded px-1.5 py-0.5 max-w-full"
            title={`${dc.path}:${dc.line} — ${dc.text}`}
          >
            <span className="font-mono text-text-secondary truncate max-w-[140px]">
              {dc.path.split(/[\\/]/).pop()}:{dc.line}
            </span>
            <button
              type="button"
              onClick={() => onRemove(dc.id)}
              className="text-text-faint hover:text-accent-red transition-colors"
              title="Remove this comment"
            >
              <X size={9} />
            </button>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-ui text-text-muted hover:text-text-primary ml-auto transition-colors"
      >
        Clear all
      </button>
    </div>
  );
}
