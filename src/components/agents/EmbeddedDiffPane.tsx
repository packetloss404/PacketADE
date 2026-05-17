import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDiff, AlertCircle } from "lucide-react";
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

/**
 * Embeddable variant of DiffPane.
 *
 * The original `DiffPane` is a fixed-position slide-out gated by
 * `useDiffPaneStore.open`. This component renders the same per-file diff
 * browser INLINE — used by the AgentInspectorPane's Diff tab. Structural
 * twin of `DiffPane` minus the fixed-position chrome and the open-state
 * store coupling; owns its own file-selection state instead.
 */

interface WriteFileEntry {
  path: string;
  content: string;
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
        content: parsed.content,
        writeCount: (existing?.writeCount ?? 0) + 1,
      });
    }
  }
  return map;
}

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

interface FileStatsProps {
  stat: PerFileDiffStat | undefined;
  loading: boolean;
}

function FileStats({ stat, loading }: FileStatsProps) {
  if (loading) return <span className="text-text-muted text-[10px]">…</span>;
  if (!stat) return <span className="text-text-muted text-[10px]">—</span>;
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

interface EmbeddedDiffPaneProps {
  conversationId: string;
}

export function EmbeddedDiffPane({ conversationId }: EmbeddedDiffPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );

  const writeFiles = useMemo(
    () => aggregateWriteFiles(conversation),
    [conversation],
  );
  const entries = useMemo(
    () =>
      Array.from(writeFiles.values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    [writeFiles],
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, messageCount]);

  const statByPath = useMemo(() => {
    const map = new Map<string, PerFileDiffStat>();
    if (aggregate) for (const s of aggregate.perFile) map.set(s.path, s);
    return map;
  }, [aggregate]);

  // Auto-select the first file when nothing valid is selected.
  useEffect(() => {
    if (entries.length === 0) return;
    if (!selectedPath || !writeFiles.has(selectedPath)) {
      setSelectedPath(entries[0].path);
    }
  }, [entries, selectedPath, writeFiles]);

  const activeEntry = selectedPath ? writeFiles.get(selectedPath) : undefined;

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bg-border bg-bg-secondary shrink-0">
        <FileDiff size={12} className="text-text-secondary" />
        <span className="text-[11px] font-medium text-text-primary">
          Changes ({entries.length} {entries.length === 1 ? "file" : "files"})
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <p className="text-[11px] text-text-muted text-center">
            No file edits in this conversation yet.
          </p>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          <div className="w-[180px] border-r border-bg-border overflow-y-auto bg-bg-secondary/50">
            <ul className="py-1">
              {entries.map((entry) => {
                const isActive = entry.path === selectedPath;
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
                      onClick={() => setSelectedPath(entry.path)}
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
                            isActive
                              ? "text-text-primary"
                              : "text-text-secondary"
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
