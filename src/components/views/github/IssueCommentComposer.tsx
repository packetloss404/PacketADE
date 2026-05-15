import { useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import type { GitHubIssue } from "@/types/github";

interface IssueCommentComposerProps {
  issue: GitHubIssue;
  onPosted?: () => void;
}

/** v0.8-C: textarea + Submit for posting a new comment to an issue. */
export function IssueCommentComposer({ issue, onPosted }: IssueCommentComposerProps) {
  const postIssueComment = useGitHubStore((s) => s.postIssueComment);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await postIssueComment({ number: issue.number }, trimmed);
      setBody("");
      onPosted?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
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
          rows={4}
          className="w-full resize-y min-h-[72px] bg-bg-primary border border-bg-border rounded px-2.5 py-2 text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue/60 font-mono"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        {error && (
          <p className="text-[10.5px] text-accent-red mt-1.5">{error}</p>
        )}
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[10px] text-text-muted">
            {trimmed.length === 0
              ? "Type a comment to submit"
              : `${trimmed.length} chars`}
          </span>
          <div className="flex-1" />
          <span className="text-[9.5px] text-text-muted font-mono">
            Ctrl+Enter to submit
          </span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium bg-accent-blue/15 text-accent-blue border border-accent-blue/30 rounded hover:bg-accent-blue/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <MessageSquarePlus size={10} />
            )}
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
