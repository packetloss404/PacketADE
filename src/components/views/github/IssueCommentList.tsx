import { useEffect, useMemo } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { useGitHubStore } from "@/stores/githubStore";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import type { GitHubIssue } from "@/types/github";

interface IssueCommentListProps {
  issue: GitHubIssue;
}

/** v0.8-C: render the comment thread for a single issue. */
export function IssueCommentList({ issue }: IssueCommentListProps) {
  const config = useGitHubStore((s) => s.config);
  const issueComments = useGitHubStore((s) => s.issueComments);
  const issueCommentsLoading = useGitHubStore((s) => s.issueCommentsLoading);
  const fetchIssueComments = useGitHubStore((s) => s.fetchIssueComments);

  const key = useMemo(() => {
    if (!config.selectedRepo) return "";
    return `${config.selectedRepo.owner}/${config.selectedRepo.repo}#${issue.number}`;
  }, [config.selectedRepo, issue.number]);

  useEffect(() => {
    if (!config.selectedRepo) return;
    fetchIssueComments({ number: issue.number });
  }, [config.selectedRepo, issue.number, fetchIssueComments]);

  const comments = issueComments[key];
  const loading = !!issueCommentsLoading[key];

  if (loading && !comments) {
    return (
      <div className="flex items-center gap-2 text-text-muted py-3">
        <Loader2 size={12} className="animate-spin" />
        <span className="text-[11px]">Loading comments...</span>
      </div>
    );
  }

  if (!comments || comments.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-text-muted py-3">
        <MessageSquare size={11} />
        No comments yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-1.5 text-[10.5px] text-text-muted">
        <MessageSquare size={10} />
        {comments.length} {comments.length === 1 ? "comment" : "comments"}
      </div>
      {comments.map((c) => (
        <article
          key={c.id}
          className="border border-bg-border rounded-md bg-bg-secondary overflow-hidden"
        >
          <header className="flex items-center gap-2 px-3 py-1.5 border-b border-bg-border bg-bg-tertiary/50">
            {c.user.avatar_url ? (
              // GitHub avatars are public CDN URLs; safe to embed.
              <img
                src={c.user.avatar_url}
                alt={c.user.login}
                className="w-4 h-4 rounded-full"
              />
            ) : (
              <div className="w-4 h-4 rounded-full bg-bg-tertiary" />
            )}
            <span className="text-[10.5px] font-medium text-text-primary">
              {c.user.login}
            </span>
            <span className="text-[10px] text-text-muted">
              commented {timeAgo(c.created_at)} ago
            </span>
            {c.updated_at && c.updated_at !== c.created_at && (
              <span className="text-[10px] text-text-muted italic">edited</span>
            )}
            <div className="flex-1" />
            <a
              href={c.html_url}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-text-muted hover:text-accent-blue"
            >
              view
            </a>
          </header>
          <div className="px-3 py-2 text-[11px] text-text-secondary">
            <MarkdownRenderer content={c.body} />
          </div>
        </article>
      ))}
    </div>
  );
}

// Local copy of GitHubView's timeAgo — kept colocated so this component is
// drop-in usable without dragging it back into the parent.
function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}
