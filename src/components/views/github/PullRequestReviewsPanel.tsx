import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MessageSquare,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { useGitHubStore } from "@/stores/githubStore";
import { relativeTime } from "@/lib/time";
import type { GitHubPr } from "@/types/github";

/**
 * Viewer for the existing GitHub review activity on a PR — formal reviews
 * (Approved / Changes Requested / Commented) plus the per-file inline comment
 * threads. Authoring: threads can be replied to here; new line comments are
 * authored from the diff gutter (DiffViewer). `refreshKey` from the parent
 * forces a refetch after a new line comment is posted.
 *
 * Mounted by `GitHubView.tsx::PRDetail` below the AI review panel.
 *
 * Data model:
 *   - Two GitHub endpoints (`/pulls/{n}/reviews` + `/pulls/{n}/comments`)
 *     are fetched in parallel on mount.
 *   - Inline comments group by `path`, then chain by `in_reply_to_id`
 *     into threads. Top-level comments (no `inReplyToId`) start a thread;
 *     replies hang off their parent.
 */

interface ReviewUser {
  login: string;
  avatarUrl: string;
}

interface PullRequestReview {
  id: number;
  user: ReviewUser;
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" | string;
  submittedAt: string | null;
  htmlUrl: string;
}

interface PullRequestReviewComment {
  id: number;
  pullRequestReviewId: number | null;
  inReplyToId: number | null;
  user: ReviewUser;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  createdAt: string;
  htmlUrl: string;
}

interface Props {
  pr: GitHubPr;
  /** Bumped by the parent after an inline comment is posted, to force a refetch. */
  refreshKey?: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** Tailwind classes + label for the formal-review state pill. */
function reviewStateStyle(state: string): { label: string; classes: string; Icon: typeof CheckCircle2 } {
  switch (state) {
    case "APPROVED":
      return {
        label: "Approved",
        classes: "bg-accent-green/15 text-accent-green border-accent-green/30",
        Icon: CheckCircle2,
      };
    case "CHANGES_REQUESTED":
      return {
        label: "Changes Requested",
        classes: "bg-accent-red/15 text-accent-red border-accent-red/30",
        Icon: XCircle,
      };
    case "COMMENTED":
      return {
        label: "Commented",
        classes: "bg-bg-primary text-text-secondary border-bg-border",
        Icon: MessageSquare,
      };
    case "DISMISSED":
      return {
        label: "Dismissed",
        classes: "bg-bg-primary text-text-muted border-bg-border",
        Icon: AlertCircle,
      };
    case "PENDING":
      return {
        label: "Pending",
        classes: "bg-accent-amber/15 text-accent-amber border-accent-amber/30",
        Icon: AlertCircle,
      };
    default:
      return {
        label: state,
        classes: "bg-bg-primary text-text-muted border-bg-border",
        Icon: MessageSquare,
      };
  }
}

/** Parse an ISO timestamp into ms; returns NaN for null/invalid. */
function parseIso(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : NaN;
}

function formatTimestamp(ts: string | null | undefined): string {
  const n = parseIso(ts);
  if (!Number.isFinite(n)) return "";
  return relativeTime(n);
}

interface CommentThread {
  root: PullRequestReviewComment;
  replies: PullRequestReviewComment[];
}

/** Group inline comments into per-file threads chained by `inReplyToId`. */
function groupCommentsByFile(comments: PullRequestReviewComment[]): Map<string, CommentThread[]> {
  // First, build an index from comment id → comment so we can resolve
  // replies in O(1).
  const byId = new Map<number, PullRequestReviewComment>();
  for (const c of comments) byId.set(c.id, c);

  // Resolve each comment's *root* — walk `inReplyToId` until we hit a
  // top-level comment. Capped at 50 hops as a safety net against
  // pathological data.
  function rootOf(c: PullRequestReviewComment): PullRequestReviewComment {
    let cur = c;
    for (let i = 0; i < 50; i++) {
      if (cur.inReplyToId == null) return cur;
      const parent = byId.get(cur.inReplyToId);
      if (!parent) return cur;
      cur = parent;
    }
    return cur;
  }

  // Build threads keyed by root id.
  const threadsByRoot = new Map<number, CommentThread>();
  // Process top-level (root) comments first so threads are created in
  // file-order rather than reply-order.
  const sorted = [...comments].sort(
    (a, b) => parseIso(a.createdAt) - parseIso(b.createdAt),
  );
  for (const c of sorted) {
    const root = rootOf(c);
    if (!threadsByRoot.has(root.id)) {
      threadsByRoot.set(root.id, { root, replies: [] });
    }
    if (c.id !== root.id) {
      threadsByRoot.get(root.id)!.replies.push(c);
    }
  }

  // Bucket threads by their root's `path`.
  const byFile = new Map<string, CommentThread[]>();
  for (const thread of threadsByRoot.values()) {
    const path = thread.root.path || "(unknown file)";
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path)!.push(thread);
  }

  // Stable file ordering — alphabetical.
  return new Map([...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function PullRequestReviewsPanel({ pr, refreshKey }: Props) {
  const { config } = useGitHubStore();
  const [reviews, setReviews] = useState<PullRequestReview[]>([]);
  const [comments, setComments] = useState<PullRequestReviewComment[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  // Reply composer: the root comment id of the thread being replied to.
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyPosting, setReplyPosting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!config.selectedRepo) {
      setLoadState({ kind: "error", message: "No repo selected" });
      return;
    }
    setLoadState({ kind: "loading" });
    try {
      const { owner, repo } = config.selectedRepo;
      const [reviewsResp, commentsResp] = await Promise.all([
        invoke<PullRequestReview[]>("github_list_pr_reviews", {
          owner,
          repo,
          prNumber: pr.number,
        }),
        invoke<PullRequestReviewComment[]>("github_list_pr_review_comments", {
          owner,
          repo,
          prNumber: pr.number,
        }),
      ]);
      setReviews(reviewsResp);
      setComments(commentsResp);
      setLoadState({ kind: "ready" });
    } catch (e) {
      setLoadState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [config.selectedRepo, pr.number]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll, refreshKey]);

  const submitReply = useCallback(
    async (rootId: number) => {
      if (!config.selectedRepo || !replyDraft.trim() || replyPosting) return;
      setReplyPosting(true);
      setReplyError(null);
      try {
        const { owner, repo } = config.selectedRepo;
        await invoke("github_reply_to_pr_review_comment", {
          owner,
          repo,
          prNumber: pr.number,
          commentId: rootId,
          body: replyDraft.trim(),
        });
        setReplyingTo(null);
        setReplyDraft("");
        await fetchAll();
      } catch (e) {
        setReplyError(e instanceof Error ? e.message : String(e));
      } finally {
        setReplyPosting(false);
      }
    },
    [config.selectedRepo, pr.number, replyDraft, replyPosting, fetchAll],
  );

  const commentsByFile = useMemo(() => groupCommentsByFile(comments), [comments]);
  const hasAnything = reviews.length > 0 || comments.length > 0;

  return (
    <div className="flex flex-col gap-3 p-3 border-t border-bg-border">
      <div className="flex items-center gap-2">
        <MessageSquare size={12} className="text-accent-blue" />
        <span className="text-[11px] font-semibold text-text-primary">
          Reviews & comments
        </span>
        {loadState.kind === "loading" && (
          <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
            <Loader2 size={10} className="animate-spin" />
            Loading…
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            void fetchAll();
          }}
          disabled={loadState.kind === "loading"}
          title="Refresh"
          className="text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={loadState.kind === "loading" ? "animate-spin" : ""} />
        </button>
      </div>

      {loadState.kind === "error" && (
        <div className="bg-accent-red/10 border border-accent-red/30 rounded px-3 py-2 text-[11px] text-accent-red">
          {loadState.message}
        </div>
      )}

      {loadState.kind === "ready" && !hasAnything && (
        <p className="text-[11px] text-text-muted italic">No reviews yet</p>
      )}

      {loadState.kind === "ready" && reviews.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Reviews ({reviews.length})
          </span>
          {reviews.map((r) => {
            const pill = reviewStateStyle(r.state);
            const Icon = pill.Icon;
            return (
              <div
                key={r.id}
                className="flex flex-col gap-1.5 bg-bg-primary border border-bg-border rounded p-2.5"
              >
                <div className="flex items-center gap-2">
                  {r.user.avatarUrl ? (
                    <img
                      src={r.user.avatarUrl}
                      alt=""
                      className="w-4 h-4 rounded-full flex-shrink-0"
                    />
                  ) : (
                    <div className="w-4 h-4 rounded-full bg-bg-border flex-shrink-0" />
                  )}
                  <span className="text-[11px] font-medium text-text-primary">
                    {r.user.login || "unknown"}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded border ${pill.classes}`}
                  >
                    <Icon size={9} />
                    {pill.label}
                  </span>
                  <div className="flex-1" />
                  <span className="text-[10px] text-text-muted">
                    {formatTimestamp(r.submittedAt)}
                  </span>
                </div>
                {r.body.trim() && (
                  <div className="text-xs text-text-primary pl-6">
                    <MarkdownRenderer content={r.body} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {loadState.kind === "ready" && commentsByFile.size > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">
            Line comments ({comments.length})
          </span>
          {[...commentsByFile.entries()].map(([path, threads]) => (
            <div
              key={path}
              className="flex flex-col gap-1.5 bg-bg-primary border border-bg-border rounded"
            >
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-bg-border bg-bg-secondary/40 rounded-t">
                <span className="text-[10px] font-mono text-text-secondary truncate flex-1">
                  {path}
                </span>
              </div>
              <div className="flex flex-col gap-2 p-2.5">
                {threads.map((thread) => {
                  const lineHint = thread.root.line ?? thread.root.originalLine;
                  return (
                    <div
                      key={thread.root.id}
                      className="flex flex-col gap-1.5 border-l-2 border-bg-border pl-2.5"
                    >
                      {lineHint != null && (
                        <span className="text-[9px] font-mono text-text-muted">
                          {path}:{lineHint}
                        </span>
                      )}
                      <CommentRow comment={thread.root} />
                      {thread.replies.map((reply) => (
                        <div key={reply.id} className="pl-3 border-l border-bg-border">
                          <CommentRow comment={reply} />
                        </div>
                      ))}
                      {replyingTo === thread.root.id ? (
                        <div className="flex flex-col gap-1.5 pl-3">
                          <textarea
                            value={replyDraft}
                            onChange={(e) => setReplyDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                e.preventDefault();
                                void submitReply(thread.root.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setReplyingTo(null);
                                setReplyDraft("");
                              }
                            }}
                            autoFocus
                            rows={2}
                            placeholder="Reply…  (Cmd/Ctrl+Enter to submit)"
                            className="w-full resize-y rounded border border-bg-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-blue focus:outline-none"
                          />
                          {replyError && (
                            <span className="text-[10px] text-accent-red">{replyError}</span>
                          )}
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setReplyingTo(null);
                                setReplyDraft("");
                                setReplyError(null);
                              }}
                              className="text-[10px] text-text-muted hover:text-text-primary"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void submitReply(thread.root.id)}
                              disabled={replyPosting || !replyDraft.trim()}
                              className="inline-flex items-center gap-1 rounded bg-accent-blue/15 px-2 py-0.5 text-[10px] font-medium text-accent-blue hover:bg-accent-blue/25 disabled:opacity-50"
                            >
                              {replyPosting && <Loader2 size={9} className="animate-spin" />}
                              Reply
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setReplyingTo(thread.root.id);
                            setReplyDraft("");
                            setReplyError(null);
                          }}
                          className="self-start pl-3 text-[10px] text-text-muted hover:text-accent-blue"
                        >
                          Reply
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentRow({ comment }: { comment: PullRequestReviewComment }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {comment.user.avatarUrl ? (
          <img
            src={comment.user.avatarUrl}
            alt=""
            className="w-4 h-4 rounded-full flex-shrink-0"
          />
        ) : (
          <div className="w-4 h-4 rounded-full bg-bg-border flex-shrink-0" />
        )}
        <span className="text-[11px] font-medium text-text-primary">
          {comment.user.login || "unknown"}
        </span>
        <span className="text-[10px] text-text-muted">
          {formatTimestamp(comment.createdAt)}
        </span>
      </div>
      <div className="text-xs text-text-primary pl-6">
        <MarkdownRenderer content={comment.body} />
      </div>
    </div>
  );
}
