import { useMemo, useRef, useState } from "react";
import { FileText, FilePlus, FileMinus, FileEdit, MessageSquarePlus, Loader2 } from "lucide-react";
import {
  groupCommentThreads,
  threadsByAnchor,
  lineAnchorKey,
  type ReviewComment,
  type CommentThread,
} from "@/lib/reviewCommentThreads";
import { relativeTime } from "@/lib/time";

/** GitHub side + file line number that a comment anchors to. */
export interface DiffCommentAnchor {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

interface DiffViewerProps {
  diff: string;
  className?: string;
  /** When provided, each diff line gets a hover affordance to author an inline
   *  review comment. Omit for a read-only diff. */
  onAddComment?: (anchor: DiffCommentAnchor, body: string) => Promise<void>;
  /** GP1: existing PR review comments, rendered inline under their anchor line. */
  reviewComments?: ReviewComment[];
}

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  fileIndex?: number;
  /** File line number on the old (LEFT) side, when this line exists there. */
  oldLine?: number;
  /** File line number on the new (RIGHT) side, when this line exists there. */
  newLine?: number;
}

/** Parse an `@@ -a,b +c,d @@` hunk header into its old/new starting lines. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/**
 * v0.8-G: parsed-file summary for the file-tree side panel.
 * `lineIndex` is the index into the flat `lines[]` array — the tree
 * clicks into this position to scroll the diff viewport.
 */
interface DiffFile {
  /** Display path, with the `a/` or `b/` prefix stripped. */
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Position of this file's first header line in the flat `lines[]`. */
  lineIndex: number;
}

interface ParsedDiff {
  lines: DiffLine[];
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Strip the `a/` or `b/` prefix from a diff path like `a/src/foo.ts`.
 * Returns the input unchanged when no recognisable prefix is found.
 */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function parseDiff(diff: string): ParsedDiff {
  const rawLines = diff.split("\n");
  const lines: DiffLine[] = [];
  const files: DiffFile[] = [];
  let currentFileIdx = -1;
  let pendingFile: { path?: string; status?: DiffFile["status"]; lineIndex?: number } | null = null;
  let totalAdditions = 0;
  let totalDeletions = 0;
  // Running file line numbers within the current hunk (set from each `@@` header).
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawLines) {
    let entry: DiffLine;
    if (line.startsWith("diff --git ")) {
      // `diff --git a/PATH b/PATH` — start of a new file. Defer file
      // registration until we see `+++`/`---` so we can resolve the
      // status correctly.
      pendingFile = { lineIndex: lines.length };
      entry = { type: "header", content: line };
    } else if (line.startsWith("--- ") && pendingFile) {
      // Source-side file header. Only a real header while a `diff --git` is
      // pending — in the hunk body, `--- x` is a removed `-- x` content line.
      const source = line.slice(4).trim();
      if (source === "/dev/null") {
        pendingFile.status = "added"; // no source → added file
      } else {
        // Capture the old path so a deletion (whose `+++` is /dev/null) still
        // reports the real file path, not "/dev/null".
        pendingFile.path = stripPrefix(source);
      }
      entry = { type: "header", content: line };
    } else if (line.startsWith("+++ ") && pendingFile) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        pendingFile.status = "deleted";
        // path already captured from the `--- a/PATH` line above.
      } else {
        // New path wins (covers renames — the RIGHT side uses the new path).
        pendingFile.path = stripPrefix(target);
        if (!pendingFile.status) pendingFile.status = "modified";
      }
      const path = pendingFile.path ?? stripPrefix(target);
      files.push({
        path,
        status: pendingFile.status ?? "modified",
        additions: 0,
        deletions: 0,
        lineIndex: pendingFile.lineIndex ?? lines.length,
      });
      currentFileIdx = files.length - 1;
      pendingFile = null;
      entry = { type: "header", content: line };
    } else if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        oldLine = hunk.oldStart;
        newLine = hunk.newStart;
      }
      entry = { type: "header", content: line };
    } else if (line.startsWith("index ")) {
      entry = { type: "header", content: line };
    } else if (line.startsWith("+")) {
      entry = { type: "add", content: line, newLine };
      newLine++;
      if (currentFileIdx >= 0) {
        files[currentFileIdx].additions++;
        totalAdditions++;
      }
    } else if (line.startsWith("-")) {
      entry = { type: "remove", content: line, oldLine };
      oldLine++;
      if (currentFileIdx >= 0) {
        files[currentFileIdx].deletions++;
        totalDeletions++;
      }
    } else if (line.startsWith("\\") || line === "") {
      // `\ No newline at end of file` marker, or a trailing split artifact —
      // NOT a real file line: give it no line numbers (so it isn't commentable)
      // and don't advance the counters, or every following line's anchor would
      // be off by one and post to a nonexistent line.
      entry = { type: "context", content: line };
    } else {
      // Context line — present on both sides.
      entry = { type: "context", content: line, oldLine, newLine };
      oldLine++;
      newLine++;
    }
    entry.fileIndex = currentFileIdx >= 0 ? currentFileIdx : undefined;
    lines.push(entry);
  }

  // Fallback when the diff doesn't include `+++` headers (e.g. partial
  // input). We still register a single anonymous file so the file-tree
  // doesn't render empty.
  if (files.length === 0 && lines.some((l) => l.type === "add" || l.type === "remove")) {
    files.push({
      path: "(unknown)",
      status: "modified",
      additions: totalAdditions,
      deletions: totalDeletions,
      lineIndex: 0,
    });
  }

  return { lines, files, totalAdditions, totalDeletions };
}

const lineStyles: Record<DiffLine["type"], string> = {
  add: "bg-accent-green/10 text-accent-green",
  remove: "bg-accent-red/10 text-accent-red",
  context: "text-text-secondary",
  header: "text-accent-blue bg-accent-blue/5 font-semibold",
};

/** v0.8-G: status glyph + colour per file. */
function StatusIcon({ status }: { status: DiffFile["status"] }) {
  if (status === "added") {
    return <FilePlus size={11} className="text-accent-green" />;
  }
  if (status === "deleted") {
    return <FileMinus size={11} className="text-accent-red" />;
  }
  return <FileEdit size={11} className="text-accent-blue" />;
}

export function DiffViewer({
  diff,
  className = "",
  onAddComment,
  reviewComments,
}: DiffViewerProps) {
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  // GP1: index review-comment threads by their diff-line anchor for O(1) lookup.
  const threadIndex = useMemo(
    () => threadsByAnchor(groupCommentThreads(reviewComments ?? [])),
    [reviewComments],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Inline-comment composer: index into parsed.lines of the line being commented.
  const [composerLine, setComposerLine] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  function scrollToFile(file: DiffFile) {
    const el = lineRefs.current[file.lineIndex];
    if (el && scrollRef.current) {
      // Anchor the line at the top of the visible diff area.
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  /** The GitHub comment anchor for a diff line, or null if not commentable. */
  function anchorForLine(line: DiffLine): DiffCommentAnchor | null {
    if (line.type === "header") return null;
    const path = line.fileIndex != null ? parsed.files[line.fileIndex]?.path : undefined;
    if (!path) return null;
    // Prefer the new side (add/context); fall back to the old side (removals).
    if (line.newLine != null) return { path, line: line.newLine, side: "RIGHT" };
    if (line.oldLine != null) return { path, line: line.oldLine, side: "LEFT" };
    return null;
  }

  function openComposer(i: number) {
    setComposerLine(i);
    setDraft("");
    setPostError(null);
  }
  function closeComposer() {
    setComposerLine(null);
    setDraft("");
    setPostError(null);
  }
  async function submitComposer(anchor: DiffCommentAnchor) {
    if (!onAddComment || !draft.trim() || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      await onAddComment(anchor, draft.trim());
      closeComposer();
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className}`}>
      {/* v0.8-G: counts header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-bg-border bg-bg-secondary px-3 py-1.5 text-[11px] text-text-secondary">
        <FileText size={11} className="text-text-muted" />
        <span>
          <span className="font-semibold text-text-primary">
            {parsed.files.length}
          </span>{" "}
          {parsed.files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="text-text-muted">·</span>
        <span className="text-accent-green">
          +{parsed.totalAdditions} additions
        </span>
        <span className="text-text-muted">·</span>
        <span className="text-accent-red">
          -{parsed.totalDeletions} deletions
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* v0.8-G: file-tree sidebar */}
        {parsed.files.length > 0 && (
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r border-bg-border bg-bg-secondary/60">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
              Files
            </div>
            <ul className="flex flex-col">
              {parsed.files.map((f, i) => (
                <li key={`${f.path}-${i}`}>
                  <button
                    type="button"
                    onClick={() => scrollToFile(f)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-text-primary hover:bg-bg-tertiary"
                    title={f.path}
                  >
                    <StatusIcon status={f.status} />
                    <span className="truncate flex-1">{shortenPath(f.path)}</span>
                    <span className="flex items-center gap-1 text-[9px] text-text-muted">
                      <span className="text-accent-green">+{f.additions}</span>
                      <span className="text-accent-red">-{f.deletions}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Diff content */}
        <div
          ref={scrollRef}
          className="font-mono text-[11px] flex-1 overflow-auto"
        >
          {parsed.lines.map((line, i) => {
            const anchor = onAddComment ? anchorForLine(line) : null;
            // GP1: existing review threads anchored on this line.
            const displayAnchor = anchorForLine(line);
            const anchorKey = displayAnchor
              ? lineAnchorKey(displayAnchor.path, displayAnchor.line, displayAnchor.side)
              : null;
            const threads = anchorKey ? threadIndex.get(anchorKey) : undefined;
            return (
              <div
                key={i}
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
              >
                <div className={`group flex items-stretch ${lineStyles[line.type]}`}>
                  {/* line-number gutter (old | new) */}
                  <span className="w-9 flex-shrink-0 select-none px-1 text-right text-[10px] tabular-nums text-text-muted/60">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="w-9 flex-shrink-0 select-none px-1 text-right text-[10px] tabular-nums text-text-muted/60">
                    {line.newLine ?? ""}
                  </span>
                  {/* comment affordance (hover) */}
                  {onAddComment &&
                    (anchor ? (
                      <button
                        type="button"
                        onClick={() => openComposer(i)}
                        title="Comment on this line"
                        className="flex w-5 flex-shrink-0 items-center justify-center text-accent-blue opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                      >
                        <MessageSquarePlus size={11} />
                      </button>
                    ) : (
                      <span className="w-5 flex-shrink-0" />
                    ))}
                  <span className="flex-1 whitespace-pre pr-3">{line.content}</span>
                </div>
                {threads?.map((t) => (
                  <InlineThread key={t.root.id} thread={t} />
                ))}
                {composerLine === i && anchor && (
                  <CommentComposer
                    anchor={anchor}
                    draft={draft}
                    setDraft={setDraft}
                    posting={posting}
                    error={postError}
                    onSubmit={() => void submitComposer(anchor)}
                    onCancel={closeComposer}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** GP1: an existing review-comment thread rendered beneath its anchor line. */
function InlineThread({ thread }: { thread: CommentThread }) {
  const comments = [thread.root, ...thread.replies];
  return (
    <div className="border-y border-bg-border bg-bg-secondary/70 px-3 py-2">
      <ul className="flex flex-col gap-1.5">
        {comments.map((c) => (
          <li key={c.id} className="font-sans">
            <div className="flex items-baseline gap-1.5 text-[10px] text-text-muted">
              <span className="font-semibold text-text-secondary">{c.user.login}</span>
              {c.createdAt && <span>{relativeTime(Date.parse(c.createdAt))}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words text-[11px] leading-snug text-text-primary">
              {c.body}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inline composer rendered directly beneath the line being commented. */
function CommentComposer({
  anchor,
  draft,
  setDraft,
  posting,
  error,
  onSubmit,
  onCancel,
}: {
  anchor: DiffCommentAnchor;
  draft: string;
  setDraft: (v: string) => void;
  posting: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border-y border-bg-border bg-bg-secondary px-3 py-2">
      <div className="mb-1 font-mono text-[10px] text-text-muted">
        Commenting on {anchor.path}:{anchor.line} ({anchor.side === "RIGHT" ? "new" : "old"})
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
        rows={3}
        placeholder="Leave a review comment…  (Cmd/Ctrl+Enter to submit)"
        className="w-full resize-y rounded border border-bg-border bg-bg-primary px-2 py-1.5 font-sans text-[11px] text-text-primary placeholder:text-text-muted focus:border-accent-blue focus:outline-none"
      />
      {error && <div className="mt-1 text-[10px] text-accent-red">{error}</div>}
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-text-muted transition-colors hover:text-text-primary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={posting || !draft.trim()}
          className="hover:bg-accent-blue/25 inline-flex items-center gap-1 rounded bg-accent-blue/15 px-2 py-1 text-[11px] font-medium text-accent-blue transition-colors disabled:opacity-50"
        >
          {posting && <Loader2 size={10} className="animate-spin" />}
          Comment
        </button>
      </div>
    </div>
  );
}

/**
 * Trim long file paths in the sidebar so they fit without wrapping.
 * Keeps the last two path segments and prefixes with `…/` when the
 * original was deeper.
 */
function shortenPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
