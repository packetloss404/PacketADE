import { useMemo, useState } from "react";
import * as Diff from "diff";
import { Plus, Check, X } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useFileDisk, type DiskState } from "@/components/agents/hooks/useFileDisk";

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

/** B1: per-line diff row computed from `Diff.diffLines` parts with running
 * old/new line counters. `side` is the file the line lives in: removed
 * lines anchor to the OLD file; added + context lines anchor to the NEW
 * file. The displayed `line` is the relevant counter for that side. */
interface DiffRow {
  /** Stable id within this diff for React key stability. */
  key: string;
  marker: "+" | "-" | " ";
  text: string;
  side: "old" | "new";
  line: number;
}

function buildRows(parts: Diff.Change[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let counter = 0;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (part.added) {
        rows.push({
          key: `r${counter++}`,
          marker: "+",
          text: line,
          side: "new",
          line: newLine,
        });
        newLine++;
      } else if (part.removed) {
        rows.push({
          key: `r${counter++}`,
          marker: "-",
          text: line,
          side: "old",
          line: oldLine,
        });
        oldLine++;
      } else {
        rows.push({
          key: `r${counter++}`,
          marker: " ",
          text: line,
          side: "new",
          line: newLine,
        });
        oldLine++;
        newLine++;
      }
    }
  }
  return rows;
}

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

  const diffParts = useMemo(() => {
    if (state.kind !== "existing") return null;
    return Diff.diffLines(state.oldContent, newContent);
  }, [state, newContent]);

  const rows = useMemo(() => (diffParts ? buildRows(diffParts) : null), [
    diffParts,
  ]);

  const counts = useMemo(() => {
    if (!rows) return { added: 0, removed: 0 };
    let added = 0;
    let removed = 0;
    for (const r of rows) {
      if (r.marker === "+") added++;
      else if (r.marker === "-") removed++;
    }
    return { added, removed };
  }, [rows]);

  if (state.kind === "loading") {
    return (
      <div className="text-[11px] text-text-secondary italic px-2 py-1">
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
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words px-2 py-1 bg-bg-primary text-text-primary overflow-x-auto">
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
      <div className="bg-bg-primary text-[11px] font-mono">
        {rows?.map((row) => (
          <DiffRowView
            key={row.key}
            row={row}
            filePath={filePath}
            conversationId={conversationId}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One diff line with hover-`+` to attach a Codex-style comment. The `+`
 * appears on hover (group-hover); clicking opens a single-line textarea
 * inline. Enter submits, Esc cancels. Submitted comments queue on the
 * conversation and are folded into the next user turn by sendMessage.
 *
 * Renders the read-only diff line when `conversationId` is omitted (e.g.
 * tests / preview surfaces that shouldn't accept comments).
 */
function DiffRowView({
  row,
  filePath,
  conversationId,
}: {
  row: DiffRow;
  filePath: string;
  conversationId?: string;
}) {
  const addDiffComment = useAgentTaskStore((s) => s.addDiffComment);
  const queued = useAgentTaskStore(
    (s) =>
      conversationId
        ? s.conversations.find((c) => c.id === conversationId)
            ?.pendingDiffComments
        : undefined,
  );

  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const rowClass =
    row.marker === "+"
      ? "bg-accent-green/10 text-accent-green"
      : row.marker === "-"
        ? "bg-accent-red/10 text-accent-red"
        : "text-text-primary";
  const hasComment = !!queued?.some(
    (c) => c.path === filePath && c.line === row.line && c.side === row.side,
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
      line: row.line,
      side: row.side,
      text: t,
    });
    setDraft("");
    setComposerOpen(false);
  }

  return (
    <>
      <div
        className={`group relative flex items-start whitespace-pre-wrap break-words ${rowClass}`}
      >
        <span className="inline-block w-4 text-text-secondary select-none px-2">
          {row.marker}
        </span>
        <span className="flex-1 pr-12">{row.text}</span>
        {conversationId && !composerOpen && (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className={`absolute right-1 top-0 flex items-center justify-center w-5 h-5 rounded text-[10px] transition-opacity ${
              hasComment
                ? "opacity-100 bg-accent-blue text-white"
                : "opacity-0 group-hover:opacity-100 bg-bg-secondary border border-bg-border text-text-muted hover:text-accent-blue hover:border-accent-blue/40"
            }`}
            title={
              hasComment
                ? `Comment queued on ${filePath}:${row.line}`
                : `Comment on ${filePath}:${row.line}`
            }
          >
            <Plus size={10} />
          </button>
        )}
      </div>
      {composerOpen && (
        <div className="flex items-center gap-1 px-2 py-1 bg-bg-secondary border-y border-accent-blue/30">
          <span className="text-[10px] text-text-muted shrink-0 font-mono">
            {filePath}:{row.line} —
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
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="p-0.5 text-accent-green hover:bg-accent-green/10 rounded disabled:opacity-40"
            title="Queue comment"
          >
            <Check size={11} />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setComposerOpen(false);
            }}
            className="p-0.5 text-text-faint hover:text-text-primary rounded"
            title="Cancel"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </>
  );
}
