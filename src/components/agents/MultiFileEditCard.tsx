import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Diff from "diff";
import {
  ChevronDown,
  ChevronRight,
  FileEdit,
  FileMinus2,
  FilePlus2,
  Folder,
} from "lucide-react";
import { useDiffPaneStore } from "../../stores/diffPaneStore";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import type { AgentToolCall } from "@/types/agent-conversation";

interface MultiFileEditCardProps {
  toolCalls: AgentToolCall[];
  conversationId: string;
  projectPath: string;
}

type FileKind = "new" | "modified" | "deleted";

interface FileEntry {
  path: string;
  newContent: string;
  kind: FileKind;
  added: number;
  removed: number;
  loading: boolean;
}

function extractWriteFileInput(
  call: AgentToolCall,
): { path: string; content: string } | null {
  const input = call.input as { path?: unknown; content?: unknown } | null;
  if (!input || typeof input !== "object") return null;
  const path = typeof input.path === "string" ? input.path : null;
  const content = typeof input.content === "string" ? input.content : "";
  if (!path) return null;
  return { path, content };
}

function countDiffLines(orig: string, next: string): {
  added: number;
  removed: number;
} {
  const parts = Diff.diffLines(orig, next);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const trimmed = part.value.endsWith("\n")
      ? part.value.slice(0, -1)
      : part.value;
    const lines = trimmed.length === 0 ? 0 : trimmed.split("\n").length;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
}

const KIND_ORDER: FileKind[] = ["new", "modified", "deleted"];

const KIND_LABEL: Record<FileKind, string> = {
  new: "New",
  modified: "Modified",
  deleted: "Deleted",
};

function KindIcon({ kind }: { kind: FileKind }) {
  if (kind === "new")
    return <FilePlus2 size={12} className="text-accent-green shrink-0" />;
  if (kind === "deleted")
    return <FileMinus2 size={12} className="text-accent-red shrink-0" />;
  return <FileEdit size={12} className="text-text-secondary shrink-0" />;
}

export function MultiFileEditCard({
  toolCalls,
  conversationId,
  projectPath,
}: MultiFileEditCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>(() => {
    const seeds: FileEntry[] = [];
    for (const call of toolCalls) {
      const parsed = extractWriteFileInput(call);
      if (!parsed) continue;
      seeds.push({
        path: parsed.path,
        newContent: parsed.content,
        kind: "modified",
        added: 0,
        removed: 0,
        loading: true,
      });
    }
    return seeds;
  });

  useEffect(() => {
    let cancelled = false;
    const seeds: FileEntry[] = [];
    for (const call of toolCalls) {
      const parsed = extractWriteFileInput(call);
      if (!parsed) continue;
      seeds.push({
        path: parsed.path,
        newContent: parsed.content,
        kind: "modified",
        added: 0,
        removed: 0,
        loading: true,
      });
    }
    setEntries(seeds);

    (async () => {
      const resolved: FileEntry[] = await Promise.all(
        seeds.map(async (entry) => {
          try {
            const original = await invoke<string | null>("read_file_for_diff", {
              projectPath,
              relPath: entry.path,
            });
            const hasOriginal =
              original !== null &&
              original !== undefined &&
              original.length > 0;
            const isEmptyNew = entry.newContent.length === 0;
            let kind: FileKind;
            if (!hasOriginal) {
              kind = "new";
            } else if (isEmptyNew) {
              kind = "deleted";
            } else {
              kind = "modified";
            }
            const { added, removed } = countDiffLines(
              hasOriginal ? (original as string) : "",
              entry.newContent,
            );
            return { ...entry, kind, added, removed, loading: false };
          } catch {
            return { ...entry, loading: false };
          }
        }),
      );
      if (!cancelled) setEntries(resolved);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, projectPath, toolCalls.length]);

  const grouped = useMemo(() => {
    const buckets: Record<FileKind, FileEntry[]> = {
      new: [],
      modified: [],
      deleted: [],
    };
    for (const entry of entries) buckets[entry.kind].push(entry);
    for (const kind of KIND_ORDER) {
      buckets[kind].sort((a, b) => a.path.localeCompare(b.path));
    }
    return buckets;
  }, [entries]);

  const totalCount = entries.length;
  const summaryParts: string[] = [];
  if (grouped.new.length > 0) summaryParts.push(`${grouped.new.length} new`);
  if (grouped.modified.length > 0)
    summaryParts.push(`${grouped.modified.length} modified`);
  if (grouped.deleted.length > 0)
    summaryParts.push(`${grouped.deleted.length} deleted`);
  const summarySuffix =
    summaryParts.length > 0 ? `: ${summaryParts.join(", ")}` : "";

  const handleOpenAll = () => {
    useDiffPaneStore.getState().openForConversation(conversationId);
  };

  const handleOpenFile = (path: string) => {
    if (/\.mdx?$/i.test(path)) {
      usePreviewPaneStore.getState().openMarkdown(path);
      return;
    }
    useDiffPaneStore.getState().openForConversation(conversationId, path);
  };

  return (
    <div className="border border-bg-border rounded overflow-hidden bg-bg-secondary">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-bg-tertiary transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-text-secondary shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-text-secondary shrink-0" />
        )}
        <Folder size={12} className="text-accent-blue shrink-0" />
        <span className="text-[11px] text-text-primary flex-1 truncate">
          Edited {totalCount} {totalCount === 1 ? "file" : "files"}
          {summarySuffix}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-bg-border">
          {KIND_ORDER.map((kind) => {
            const list = grouped[kind];
            if (list.length === 0) return null;
            return (
              <div key={kind}>
                <div className="px-2 py-1 bg-bg-primary border-b border-bg-border">
                  <span className="text-[10px] uppercase tracking-wide text-text-secondary">
                    {KIND_LABEL[kind]} ({list.length})
                  </span>
                </div>
                {list.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    onClick={() => handleOpenFile(entry.path)}
                    className="w-full flex items-center gap-2 px-2 py-1 hover:bg-bg-tertiary transition-colors text-left border-b border-bg-border/40 last:border-b-0"
                  >
                    <KindIcon kind={entry.kind} />
                    <span className="text-[11px] font-mono text-text-primary truncate flex-1">
                      {entry.path}
                    </span>
                    {entry.loading ? (
                      <span className="text-[10px] text-text-secondary italic">
                        ...
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[11px] font-mono text-accent-green">
                          +{entry.added}
                        </span>
                        <span className="text-[11px] font-mono text-accent-red">
                          -{entry.removed}
                        </span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
          <div className="px-2 py-1.5 border-t border-bg-border bg-bg-primary flex justify-end">
            <button
              type="button"
              onClick={handleOpenAll}
              className="text-[11px] text-accent-blue hover:text-accent-green transition-colors"
            >
              Open all in diff pane
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
