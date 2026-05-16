import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useIssueStore } from "@/stores/issueStore";

interface IssueCommentComposerProps {
  issueId: string;
}

/**
 * v0.8.5: textarea + Submit for inline comments on a local Issue.
 *
 * Intentionally **no** Ctrl+Enter submit hotkey — mirrors `CommitModal`'s
 * convention to prevent accidental sends while drafting. Submit is button-only.
 */
export function IssueCommentComposer({ issueId }: IssueCommentComposerProps) {
  const addIssueComment = useIssueStore((s) => s.addIssueComment);
  const [body, setBody] = useState("");

  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0;

  function handleSubmit() {
    if (!canSubmit) return;
    const created = addIssueComment(issueId, trimmed, "user");
    if (created) setBody("");
  }

  return (
    <div className="border border-bg-border rounded-md bg-bg-secondary overflow-hidden">
      <header className="flex items-center gap-1.5 px-3 py-1.5 border-b border-bg-border bg-bg-tertiary/50">
        <MessageSquarePlus size={11} className="text-accent-blue" />
        <span className="text-[10.5px] font-medium text-text-primary">
          Add a comment
        </span>
        <div className="flex-1" />
        <span className="text-[9.5px] text-text-muted font-mono">markdown</span>
      </header>
      <div className="p-2.5">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Leave a comment. Markdown supported — **bold**, `code`, links, lists."
          rows={3}
          className="w-full resize-y min-h-[60px] bg-bg-primary border border-bg-border rounded px-2.5 py-2 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60 font-mono"
        />
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[10px] text-text-muted">
            {trimmed.length === 0
              ? "Type a comment to submit"
              : `${trimmed.length} chars`}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MessageSquarePlus size={10} />
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
