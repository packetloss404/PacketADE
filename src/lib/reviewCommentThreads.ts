// GP1: PR review-comment threading — shared by the reviews side-panel and the
// inline-in-diff rendering. A flat list of inline review comments is grouped
// into threads (chained by `inReplyToId`) and indexed by their diff-line anchor
// so the DiffViewer can look up which threads sit on a given line.

export interface ReviewCommentUser {
  login: string;
  avatarUrl: string;
}

export interface ReviewComment {
  id: number;
  pullRequestReviewId?: number | null;
  inReplyToId: number | null;
  user: ReviewCommentUser;
  body: string;
  path: string;
  /** HEAD-side diff line; null for outdated comments on vanished lines. */
  line: number | null;
  originalLine?: number | null;
  /** `LEFT | RIGHT` — which side of the diff the comment anchors to. */
  side: string | null;
  createdAt: string;
  htmlUrl: string;
}

export interface CommentThread {
  root: ReviewComment;
  replies: ReviewComment[];
}

/** Parse an ISO timestamp into ms; +Inf for null/invalid (sorts stably last). */
function parseIso(ts: string | null | undefined): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Group inline comments into threads chained by `inReplyToId`. Each thread is a
 * root (top-level comment) plus its replies in chronological order. Root
 * resolution walks the reply chain (capped to guard against pathological data).
 */
export function groupCommentThreads(comments: ReviewComment[]): CommentThread[] {
  const byId = new Map<number, ReviewComment>();
  for (const c of comments) byId.set(c.id, c);

  const rootOf = (c: ReviewComment): ReviewComment => {
    let cur = c;
    for (let i = 0; i < 50; i++) {
      if (cur.inReplyToId == null) return cur;
      const parent = byId.get(cur.inReplyToId);
      if (!parent) return cur;
      cur = parent;
    }
    return cur;
  };

  const sorted = [...comments].sort((a, b) => parseIso(a.createdAt) - parseIso(b.createdAt));
  const threadsByRoot = new Map<number, CommentThread>();
  for (const c of sorted) {
    const root = rootOf(c);
    if (!threadsByRoot.has(root.id)) threadsByRoot.set(root.id, { root, replies: [] });
    if (c.id !== root.id) threadsByRoot.get(root.id)!.replies.push(c);
  }
  return [...threadsByRoot.values()];
}

/** Normalize a diff side to LEFT/RIGHT (defaulting to RIGHT / new file). */
function normalizeSide(side: string | null | undefined): "LEFT" | "RIGHT" {
  return (side ?? "RIGHT").toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}

/**
 * Stable per-line anchor key. Returns null for comments with no line (outdated),
 * which can't be placed in the diff. Uses a JSON tuple so paths containing any
 * character can't collide.
 */
export function lineAnchorKey(
  path: string,
  line: number | null | undefined,
  side: string | null | undefined,
): string | null {
  if (line == null) return null;
  return JSON.stringify([path, line, normalizeSide(side)]);
}

/**
 * Index threads by their root comment's diff-line anchor, so a diff line can
 * look up the threads that belong to it. Threads with no placeable line
 * (outdated) are dropped from the index (they still show in the side panel).
 */
export function threadsByAnchor(threads: CommentThread[]): Map<string, CommentThread[]> {
  const map = new Map<string, CommentThread[]>();
  for (const t of threads) {
    const key = lineAnchorKey(t.root.path, t.root.line, t.root.side);
    if (!key) continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(t);
    else map.set(key, [t]);
  }
  return map;
}
