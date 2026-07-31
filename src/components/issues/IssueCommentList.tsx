import { useEffect, useState } from "react";
import { MessageSquare, Trash2, Bot, User, Wrench } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/ui/ConfirmDeleteModal";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { relativeTime } from "@/lib/time";
import {
  useIssueStore,
  type IssueComment,
} from "@/stores/issueStore";

interface IssueCommentListProps {
  issueId: string;
  comments: IssueComment[];
  /**
   * Lets the host modal know a confirm is layered on top of it, so it can hand
   * Escape to that dialog instead of closing out from under it.
   */
  onConfirmingChange?: (open: boolean) => void;
}

/** First line of the body, clipped — enough to identify which comment goes. */
function commentPreview(body: string): string {
  const firstLine = body.trim().split("\n")[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || "(empty comment)";
}

/**
 * v0.8.5: render the inline comment thread for a local Issue. Mirrors the UX
 * of the GitHub-side `IssueCommentList` (one card per comment with author,
 * relative timestamp, markdown body), but persists from `issueStore` rather
 * than the GitHub API.
 *
 * Comment deletion goes through the shared `ConfirmDeleteModal` like every
 * other destructive action in the app: the trash icon used to delete on the
 * first click, with no confirm and no undo, on a 10px hover-only target.
 */
export function IssueCommentList({
  issueId,
  comments,
  onConfirmingChange,
}: IssueCommentListProps) {
  const deleteIssueComment = useIssueStore((s) => s.deleteIssueComment);
  const [pendingDelete, setPendingDelete] = useState<IssueComment | null>(null);

  useEffect(() => {
    onConfirmingChange?.(pendingDelete !== null);
  }, [pendingDelete, onConfirmingChange]);

  if (comments.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-text-muted py-3">
        <MessageSquare size={11} />
        No comments yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
        <MessageSquare size={10} />
        {comments.length} {comments.length === 1 ? "comment" : "comments"}
      </div>
      {comments.map((c) => (
        <article
          key={c.id}
          className="border border-bg-border rounded-md bg-bg-primary overflow-hidden group"
        >
          <header className="flex items-center gap-2 px-3 py-1.5 border-b border-bg-border bg-bg-tertiary/40">
            <AuthorBadge author={c.author} />
            <span className="text-[10px] text-text-muted">
              {relativeTime(c.createdAt)}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setPendingDelete(c)}
              className="p-0.5 text-text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-accent-red transition-all"
              aria-label={`Delete comment by ${c.author}`}
              title="Delete comment"
            >
              <Trash2 size={10} />
            </button>
          </header>
          <div className="px-3 py-2 text-[11px] text-text-secondary">
            <MarkdownRenderer content={c.body} />
          </div>
        </article>
      ))}

      {pendingDelete && (
        <ConfirmDeleteModal
          title="Delete comment?"
          entityName={commentPreview(pendingDelete.body)}
          description="will be removed from this issue."
          onConfirm={() => {
            deleteIssueComment(issueId, pendingDelete.id);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function AuthorBadge({ author }: { author: IssueComment["author"] }) {
  if (author === "agent") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-accent-blue">
        <Bot size={10} />
        agent
      </span>
    );
  }
  if (author === "system") {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-text-muted">
        <Wrench size={10} />
        system
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-text-primary">
      <User size={10} />
      you
    </span>
  );
}
