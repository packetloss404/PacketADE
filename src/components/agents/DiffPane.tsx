import { useEffect, useMemo, useState } from "react";
import { X, FileDiff, FilePlus2, AlertCircle } from "lucide-react";
import * as Diff from "diff";
import { useDiffPaneStore } from "@/stores/diffPaneStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { readFileForDiff } from "@/lib/tauri";
import type {
  AgentConversation,
  AgentToolCall,
} from "@/types/agent-conversation";

/* -------------------------------------------------------------------------- */
/*                              Tool-call parsing                             */
/* -------------------------------------------------------------------------- */

interface WriteFileEntry {
  path: string;
  /** Latest-wins content (last `write_file` for this path in the conversation). */
  content: string;
  /** Total number of write_file invocations across the conversation. */
  writeCount: number;
}

function parseWriteFile(
  tc: AgentToolCall,
): { path: string; content: string } | null {
  if (tc.name !== "write_file") return null;
  const raw = (tc as AgentToolCall & { input?: unknown }).input;
  if (raw == null) return null;
  try {
    let obj: unknown = raw;
    if (typeof raw === "string") obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const path =
        typeof rec.path === "string"
          ? rec.path
          : typeof rec.file_path === "string"
            ? rec.file_path
            : undefined;
      const content =
        typeof rec.content === "string" ? rec.content : undefined;
      if (path && content != null) return { path, content };
    }
  } catch {
    return null;
  }
  return null;
}

function aggregateWriteFiles(
  conv: AgentConversation | undefined,
): Map<string, WriteFileEntry> {
  const map = new Map<string, WriteFileEntry>();
  if (!conv) return map;
  for (const msg of conv.messages) {
    if (!msg.toolCalls?.length) continue;
    for (const tc of msg.toolCalls) {
      const parsed = parseWriteFile(tc);
      if (!parsed) continue;
      const existing = map.get(parsed.path);
      map.set(parsed.path, {
        path: parsed.path,
        content: parsed.content, // latest wins (loop iterates in chronological order)
        writeCount: (existing?.writeCount ?? 0) + 1,
      });
    }
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/*                                  Diff hook                                 */
/* -------------------------------------------------------------------------- */

type DiskState =
  | { kind: "loading" }
  | { kind: "new" }
  | { kind: "existing"; oldContent: string }
  | { kind: "error" };

function useFileDisk(
  projectPath: string | undefined,
  filePath: string | null,
): DiskState {
  const [state, setState] = useState<DiskState>({ kind: "loading" });
  useEffect(() => {
    if (!projectPath || !filePath) {
      setState({ kind: "new" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const result = await readFileForDiff(projectPath, filePath);
        if (cancelled) return;
        if (result === null || result === undefined) {
          setState({ kind: "new" });
        } else {
          setState({ kind: "existing", oldContent: result });
        }
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, filePath]);
  return state;
}

function countDiffLines(parts: Diff.Change[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lines = part.value.endsWith("\n")
      ? part.value.split("\n").length - 1
      : part.value.split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

/* -------------------------------------------------------------------------- */
/*                                Per-row stats                               */
/* -------------------------------------------------------------------------- */

interface FileStatsProps {
  projectPath: string;
  entry: WriteFileEntry;
}

function FileStats({ projectPath, entry }: FileStatsProps) {
  const disk = useFileDisk(projectPath, entry.path);
  const { added, removed, isNew } = useMemo(() => {
    if (disk.kind === "new") {
      const lines = entry.content.split("\n").length;
      return { added: lines, removed: 0, isNew: true };
    }
    if (disk.kind !== "existing") return { added: 0, removed: 0, isNew: false };
    const parts = Diff.diffLines(disk.oldContent, entry.content);
    const c = countDiffLines(parts);
    return { ...c, isNew: false };
  }, [disk, entry.content]);

  if (disk.kind === "loading") {
    return <span className="text-text-muted text-[10px]">…</span>;
  }
  return (
    <span className="flex items-center gap-1 font-mono text-[10px]">
      {isNew && (
        <span
          className="text-accent-green border border-accent-green/30 bg-accent-green/10 px-1 rounded"
          title="New file"
        >
          new
        </span>
      )}
      <span className="text-accent-green">+{added}</span>
      <span className="text-accent-red">-{removed}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Diff body                                  */
/* -------------------------------------------------------------------------- */

interface DiffBodyProps {
  projectPath: string;
  entry: WriteFileEntry;
}

function DiffBody({ projectPath, entry }: DiffBodyProps) {
  const disk = useFileDisk(projectPath, entry.path);

  if (disk.kind === "loading") {
    return (
      <div className="px-3 py-4 text-[11px] text-text-secondary italic">
        Loading file from disk…
      </div>
    );
  }

  if (disk.kind === "error") {
    return (
      <div className="px-3 py-4 text-[11px] text-accent-red flex items-center gap-2">
        <AlertCircle size={12} />
        Could not read original file from disk.
      </div>
    );
  }

  if (disk.kind === "new") {
    const lines = entry.content.split("\n");
    return (
      <div className="bg-bg-primary">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-bg-border">
          <FilePlus2 size={12} className="text-accent-green" />
          <span className="text-[11px] font-mono text-text-primary truncate flex-1">
            {entry.path}
          </span>
          <span className="text-accent-green border border-accent-green/30 bg-accent-green/10 text-[10px] px-1.5 py-0.5 rounded font-mono">
            New file
          </span>
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className="px-3 bg-accent-green/10 text-accent-green"
            >
              <span className="inline-block w-4 text-text-secondary select-none">
                +
              </span>
              {line}
            </div>
          ))}
        </pre>
      </div>
    );
  }

  const parts = Diff.diffLines(disk.oldContent, entry.content);
  const counts = countDiffLines(parts);

  return (
    <div className="bg-bg-primary">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border-b border-bg-border">
        <FileDiff size={12} className="text-text-secondary" />
        <span className="text-[11px] font-mono text-text-primary truncate flex-1">
          {entry.path}
        </span>
        <span className="text-[10px] font-mono text-accent-green">
          +{counts.added}
        </span>
        <span className="text-[10px] font-mono text-accent-red">
          -{counts.removed}
        </span>
      </div>
      <div>
        {parts.map((part, idx) => {
          const lines = part.value.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const gutter = part.added ? "+" : part.removed ? "-" : " ";
          const rowClass = part.added
            ? "bg-accent-green/10 text-accent-green"
            : part.removed
              ? "bg-accent-red/10 text-accent-red"
              : "text-text-primary";
          return (
            <pre
              key={idx}
              className={`text-[11px] font-mono whitespace-pre-wrap break-words ${rowClass}`}
            >
              {lines.map((line, li) => (
                <div key={li} className="px-3">
                  <span className="inline-block w-4 text-text-secondary select-none">
                    {gutter}
                  </span>
                  {line}
                </div>
              ))}
            </pre>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Main pane                                 */
/* -------------------------------------------------------------------------- */

export function DiffPane() {
  const { open, conversationId, selectedFilePath, close, selectFile } =
    useDiffPaneStore();

  const conversation = useAgentTaskStore((s) =>
    conversationId
      ? s.conversations.find((c) => c.id === conversationId)
      : undefined,
  );

  const writeFiles = useMemo(
    () => aggregateWriteFiles(conversation),
    [conversation],
  );
  const entries = useMemo(
    () => Array.from(writeFiles.values()).sort((a, b) => a.path.localeCompare(b.path)),
    [writeFiles],
  );

  // Auto-select the first file when nothing is selected (or the selection
  // points to a path no longer in the aggregate map).
  useEffect(() => {
    if (!open) return;
    if (entries.length === 0) return;
    if (!selectedFilePath || !writeFiles.has(selectedFilePath)) {
      selectFile(entries[0].path);
    }
  }, [open, entries, selectedFilePath, writeFiles, selectFile]);

  if (!open) return null;

  const activeEntry =
    selectedFilePath && writeFiles.get(selectedFilePath);

  return (
    <div
      className="fixed top-0 right-0 h-full w-[480px] bg-bg-primary border-l border-bg-border shadow-2xl z-40 flex flex-col"
      role="complementary"
      aria-label="File changes diff pane"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <div className="flex items-center gap-2">
          <FileDiff size={14} className="text-text-secondary" />
          <span className="text-xs font-medium text-text-primary">
            Changes ({entries.length}{" "}
            {entries.length === 1 ? "file" : "files"})
          </span>
        </div>
        <button
          type="button"
          onClick={close}
          className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Close diff pane"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-[11px] text-text-muted text-center">
            No file edits in this conversation yet.
          </p>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left: file list */}
          <div className="w-[180px] border-r border-bg-border overflow-y-auto bg-bg-secondary/50">
            <ul className="py-1">
              {entries.map((entry) => {
                const isActive = entry.path === selectedFilePath;
                const baseName =
                  entry.path.split(/[\\/]/).pop() ?? entry.path;
                const dir = entry.path.slice(
                  0,
                  Math.max(0, entry.path.length - baseName.length - 1),
                );
                return (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => selectFile(entry.path)}
                      className={`w-full text-left px-2 py-1.5 flex flex-col gap-0.5 transition-colors ${
                        isActive
                          ? "bg-bg-hover border-l-2 border-accent-green"
                          : "hover:bg-bg-hover/60 border-l-2 border-transparent"
                      }`}
                      title={entry.path}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span
                          className={`text-[11px] font-mono truncate ${
                            isActive ? "text-text-primary" : "text-text-secondary"
                          }`}
                        >
                          {baseName}
                        </span>
                        {conversation?.projectPath && (
                          <FileStats
                            projectPath={conversation.projectPath}
                            entry={entry}
                          />
                        )}
                      </div>
                      {dir && (
                        <span className="text-[10px] text-text-muted truncate">
                          {dir}
                        </span>
                      )}
                      {entry.writeCount > 1 && (
                        <span className="text-[10px] text-text-muted">
                          {entry.writeCount} writes
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Right: diff body */}
          <div className="flex-1 overflow-y-auto">
            {activeEntry && conversation?.projectPath ? (
              <DiffBody
                projectPath={conversation.projectPath}
                entry={activeEntry}
              />
            ) : (
              <div className="px-4 py-6 text-[11px] text-text-muted">
                Select a file to view its diff.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
