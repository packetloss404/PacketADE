import { useMemo, useState } from "react";
import { Plus, Check, X } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFileDisk, type DiskState } from "@/components/agents/hooks/useFileDisk";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  buildDiffRows,
  DiffRowView,
  languageForPath,
  rowAnchor,
  MAX_HIGHLIGHT_ROWS,
  type DiffRow,
} from "@/components/agents/diff/DiffRows";

interface ToolDiffViewProps {
  projectPath: string;
  filePath: string;
  newContent: string;
  /** Pre-resolved prior file content. When provided, skip the disk read.
   * Pass null/empty string for new files; pass undefined to fall back to disk. */
  oldContent?: string | null;
  /** B1: when set, each diff row shows a hover-`+` button that opens an
   * inline composer; submitted comments are queued on the conversation
   * and folded into the next user turn. Omit to render a read-only diff. */
  conversationId?: string;
}

type LoadState = DiskState;

export function ToolDiffView({
  projectPath,
  filePath,
  newContent,
  oldContent,
  conversationId,
}: ToolDiffViewProps) {
  // Skip the disk read when the caller already supplied `oldContent`; the
  // hook treats a null filePath as "new file" which we then override below.
  const hasPreseededContent = oldContent !== undefined;
  const { state: diskState } = useFileDisk(
    projectPath,
    hasPreseededContent ? null : filePath,
  );
  const state: LoadState = useMemo(() => {
    if (oldContent === null) return { kind: "new" };
    if (typeof oldContent === "string")
      return { kind: "existing", oldContent };
    return diskState;
  }, [oldContent, diskState]);

  const rows = useMemo(() => {
    if (state.kind !== "existing") return null;
    return buildDiffRows(state.oldContent, newContent);
  }, [state, newContent]);

  const language = useMemo(() => languageForPath(filePath), [filePath]);
  // Disable per-line highlighting on very large whole-file diffs to stay
  // responsive; the diff still renders (gutter + tint) as plain monospace.
  const rowLanguage =
    rows && rows.length > MAX_HIGHLIGHT_ROWS ? undefined : language;

  const counts = useMemo(() => {
    if (!rows) return { added: 0, removed: 0 };
    let added = 0;
    let removed = 0;
    for (const r of rows) {
      if (r.kind === "add") added++;
      else if (r.kind === "del") removed++;
    }
    return { added, removed };
  }, [rows]);

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-text-secondary px-2 py-1">
        <Spinner size={12} className="text-text-muted" />
        Loading diff...
      </div>
    );
  }

  if (state.kind === "new") {
    return (
      <div className="border border-bg-border rounded overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border">
          <span className="text-[11px] font-mono text-text-primary truncate">
            {filePath}
          </span>
          <span className="text-accent-green border border-accent-green/30 bg-accent-green/10 text-[11px] px-2 py-0.5 rounded">
            New file
          </span>
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words px-2 py-1 bg-accent-green/5 text-text-primary border-l-2 border-accent-green overflow-x-auto">
          {newContent}
        </pre>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="border border-bg-border rounded overflow-hidden">
        <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border">
          <span className="text-[11px] font-mono text-text-primary truncate">
            {filePath}
          </span>
          <span className="text-[11px] text-text-secondary italic">
            Could not read original file
          </span>
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words px-2 py-1 bg-bg-primary text-text-primary overflow-x-auto">
          {newContent}
        </pre>
      </div>
    );
  }

  // existing + diff
  return (
    <div className="border border-bg-border rounded overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1 bg-bg-secondary border-b border-bg-border">
        <span className="text-[11px] font-mono text-text-primary truncate flex-1">
          {filePath}
        </span>
        <span className="text-[11px] font-mono text-accent-green">
          +{counts.added}
        </span>
        <span className="text-[11px] font-mono text-accent-red">
          -{counts.removed}
        </span>
      </div>
      <div className="bg-bg-primary overflow-x-auto">
        {rows?.map((row) => (
          <CommentableRow
            key={row.key}
            row={row}
            language={rowLanguage}
            filePath={filePath}
            conversationId={conversationId}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One shared diff row plus the B1 hover-`+` comment affordance. The `+`
 * appears on hover (group-hover); clicking opens a single-line composer
 * inline below the row. Enter submits, Esc cancels. Submitted comments queue
 * on the conversation and are folded into the next user turn by sendMessage.
 *
 * Renders the read-only row when `conversationId` is omitted (e.g. tests /
 * preview surfaces that shouldn't accept comments).
 */
function CommentableRow({
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
            className={`sticky right-1 ml-auto self-start flex items-center justify-center w-5 h-5 rounded text-[10px] transition-opacity ${
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
          <span className="text-[10px] text-text-muted shrink-0 font-mono">
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
                setDraft("");
                setComposerOpen(false);
              }
            }}
            autoFocus
            placeholder="Add a comment (Enter to queue, Esc to cancel)"
            className="flex-1 bg-bg-primary border border-bg-border rounded px-1.5 py-0.5 text-[11px] text-text-primary focus:outline-none focus:border-accent-blue/60"
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
