import { useState } from "react";
import { Plus, Check, X } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  DiffRowView,
  rowAnchor,
  type DiffRow,
} from "@/components/agents/diff/DiffRows";

/**
 * One shared diff row plus the B1 hover-`+` comment affordance. The `+`
 * appears on hover (group-hover); clicking opens a single-line composer
 * inline below the row. Enter submits, Esc cancels. Submitted comments queue
 * on the conversation and are folded into the next user turn by sendMessage
 * (the queue is surfaced by PendingDiffCommentsStrip above the composer).
 *
 * Renders the read-only row when `conversationId` is omitted (e.g. tests /
 * preview surfaces that shouldn't accept comments).
 *
 * PROTECTED behavior (consensus keep-list): per-row diff line-comments
 * feeding the next turn. Extracted verbatim from the old ToolDiffView so it
 * survives inside the canonical review surface.
 */
export function CommentableRow({
  row,
  language,
  filePath,
  conversationId,
}: {
  row: DiffRow;
  language?: string;
  filePath: string;
  conversationId?: string;
}) {
  const addDiffComment = useAgentTaskStore((s) => s.addDiffComment);
  const queued = useAgentTaskStore((s) =>
    conversationId
      ? s.conversations.find((c) => c.id === conversationId)
          ?.pendingDiffComments
      : undefined,
  );

  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const anchor = rowAnchor(row);
  const hasComment = !!queued?.some(
    (c) => c.path === filePath && c.line === anchor.line && c.side === anchor.side,
  );

  function submit() {
    if (!conversationId) return;
    const t = draft.trim();
    if (!t) {
      setComposerOpen(false);
      return;
    }
    addDiffComment(conversationId, {
      path: filePath,
      line: anchor.line,
      side: anchor.side,
      text: t,
    });
    setDraft("");
    setComposerOpen(false);
  }

  return (
    <>
      <DiffRowView row={row} language={language}>
        {conversationId && !composerOpen && (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className={`sticky right-1 ml-auto self-start flex items-center justify-center w-5 h-5 rounded text-meta transition-opacity ${
              hasComment
                ? "opacity-100 bg-accent-blue/20 text-accent-blue"
                : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 bg-bg-secondary border border-bg-border text-text-muted hover:text-accent-blue hover:border-accent-blue/40"
            }`}
            title={
              hasComment
                ? `Comment queued on ${filePath}:${anchor.line}`
                : `Comment on ${filePath}:${anchor.line}`
            }
          >
            <Plus size={10} />
          </button>
        )}
      </DiffRowView>
      {composerOpen && (
        <div className="flex items-center gap-1 min-w-full px-2 py-1 bg-bg-secondary border-y border-accent-blue/30">
          <span className="text-meta text-text-muted shrink-0 font-mono">
            {filePath}:{anchor.line} —
          </span>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // Escape here means "cancel the comment", never "close the
                // hosting review overlay" — keep it out of window handlers.
                e.stopPropagation();
                setDraft("");
                setComposerOpen(false);
              }
            }}
            autoFocus
            placeholder="Add a comment (Enter to queue, Esc to cancel)"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-1.5 py-0.5 text-ui text-text-primary focus:outline-none focus:border-accent-blue/60"
          />
          <Tooltip content="Queue comment">
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="p-0.5 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-40"
            >
              <Check size={11} />
            </button>
          </Tooltip>
          <Tooltip content="Cancel">
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setComposerOpen(false);
              }}
              className="p-0.5 text-text-faint hover:text-text-primary rounded"
            >
              <X size={11} />
            </button>
          </Tooltip>
        </div>
      )}
    </>
  );
}
