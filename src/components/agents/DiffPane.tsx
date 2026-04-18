import { useCallback, useEffect, useMemo, useState } from "react";
import { X, FileDiff, AlertCircle } from "lucide-react";
import { useDiffPaneStore } from "@/stores/diffPaneStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { readFileForDiff, writeFileContents } from "@/lib/tauri";
import { HunkSelectableDiff } from "@/components/agents/HunkSelectableDiff";
import {
  aggregateConversationDiffs,
  type ConversationDiffAggregate,
  type PerFileDiffStat,
} from "@/lib/aggregateConversationDiffs";
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
): { state: DiskState; refresh: () => Promise<void> } {
  const [state, setState] = useState<DiskState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

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
  }, [projectPath, filePath, reloadTick]);

  const refresh = useCallback(async () => {
    setReloadTick((n) => n + 1);
  }, []);

  return { state, refresh };
}

/**
 * Combine a project root with a relative file path to produce the absolute
 * path expected by `writeFileContents`. Preserves the project's existing
 * separator style ('\\' on Windows project paths, '/' otherwise).
 */
function joinAbsolutePath(projectPath: string, relPath: string): string {
  const usesBackslash = projectPath.includes("\\") && !projectPath.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const trimmedRoot = projectPath.replace(/[\\/]+$/, "");
  const trimmedRel = relPath.replace(/^[\\/]+/, "");
  const normalizedRel = usesBackslash
    ? trimmedRel.replace(/\//g, "\\")
    : trimmedRel.replace(/\\/g, "/");
  return `${trimmedRoot}${sep}${normalizedRel}`;
}

/* -------------------------------------------------------------------------- */
/*                                Per-row stats                               */
/* -------------------------------------------------------------------------- */

interface FileStatsProps {
  /** Pre-computed per-file stat from `aggregateConversationDiffs`. */
  stat: PerFileDiffStat | undefined;
  /** True while the parent is still resolving the aggregate. */
  loading: boolean;
}

function FileStats({ stat, loading }: FileStatsProps) {
  if (loading) {
    return <span className="text-text-muted text-[10px]">…</span>;
  }
  if (!stat) {
    return <span className="text-text-muted text-[10px]">—</span>;
  }
  return (
    <span className="flex items-center gap-1 font-mono text-[10px]">
      {stat.isNew && (
        <span
          className="text-accent-green border border-accent-green/30 bg-accent-green/10 px-1 rounded"
          title="New file"
        >
          new
        </span>
      )}
      <span className="text-accent-green">+{stat.adds}</span>
      <span className="text-accent-red">-{stat.dels}</span>
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
  const { state: disk, refresh } = useFileDisk(projectPath, entry.path);

  const handleApply = useCallback(
    async (finalContent: string) => {
      const absolutePath = joinAbsolutePath(projectPath, entry.path);
      await writeFileContents(absolutePath, projectPath, finalContent);
      // Re-read so the diff view reflects the new on-disk state and any
      // unselected hunks become the only remaining changes to consider.
      await refresh();
    },
    [projectPath, entry.path, refresh],
  );

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

  const originalContent = disk.kind === "existing" ? disk.oldContent : null;

  return (
    <HunkSelectableDiff
      originalContent={originalContent}
      newContent={entry.content}
      filePath={entry.path}
      onApplySelection={handleApply}
    />
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

  // Cache the full diff aggregate (per-file +/- counts). Recomputes whenever
  // the conversation message count changes — that's a cheap proxy for "new
  // tool calls have arrived".
  const messageCount = conversation?.messages.length ?? 0;
  const [aggregate, setAggregate] = useState<ConversationDiffAggregate | null>(
    null,
  );
  const [aggregateLoading, setAggregateLoading] = useState(false);
  useEffect(() => {
    if (!conversation) {
      setAggregate(null);
      return;
    }
    let cancelled = false;
    setAggregateLoading(true);
    (async () => {
      try {
        const result = await aggregateConversationDiffs(conversation);
        if (!cancelled) setAggregate(result);
      } catch {
        if (!cancelled) setAggregate(null);
      } finally {
        if (!cancelled) setAggregateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally key on conversation identity + message count so streaming
    // tool-call arrivals refresh the aggregate without re-running on every
    // unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, messageCount]);

  const statByPath = useMemo(() => {
    const map = new Map<string, PerFileDiffStat>();
    if (aggregate) {
      for (const s of aggregate.perFile) map.set(s.path, s);
    }
    return map;
  }, [aggregate]);

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
                            stat={statByPath.get(entry.path)}
                            loading={aggregateLoading && !aggregate}
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
