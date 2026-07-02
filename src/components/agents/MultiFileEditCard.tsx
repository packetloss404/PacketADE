import { memo, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight,
  FileEdit,
  FileMinus2,
  FilePlus2,
  Folder,
} from "lucide-react";
import { useReviewStore } from "@/stores/reviewStore";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { Spinner } from "@/components/ui/Spinner";
import { materializeEdits } from "@/lib/parseToolInput";
import {
  collectEditGroups,
  countLineChanges,
  type FileEditGroup,
} from "@/lib/diffUtils";
import type { AgentToolCall } from "@/types/agent-conversation";

interface MultiFileEditCardProps {
  toolCalls: AgentToolCall[];
  conversationId: string;
  projectPath: string;
}

type FileKind = "new" | "modified" | "deleted";

interface FileEntry {
  path: string;
  group: FileEditGroup;
  kind: FileKind;
  added: number;
  removed: number;
  loading: boolean;
}

/**
 * Build one seed entry per unique file path via the shared canonical-edit
 * collector (fires for write_file, Claude Code's Write/Edit/MultiEdit/
 * NotebookEdit, and Codex apply_patch alike). If the agent edits the same
 * file twice in a turn, the chain collapses into one row per file (no
 * duplicate React keys) and we count files, not writes.
 */
function buildSeeds(
  toolCalls: AgentToolCall[],
  projectPath: string,
): FileEntry[] {
  return [...collectEditGroups(toolCalls, projectPath).values()].map((group) => ({
    path: group.path,
    group,
    kind: "modified" as FileKind,
    added: 0,
    removed: 0,
    loading: true,
  }));
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

function MultiFileEditCardImpl({
  toolCalls,
  conversationId,
  projectPath,
}: MultiFileEditCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>(() =>
    buildSeeds(toolCalls, projectPath),
  );

  useEffect(() => {
    let cancelled = false;
    const seeds = buildSeeds(toolCalls, projectPath);
    setEntries(seeds);

    (async () => {
      const { getBaseline, getToolCallBaseline } =
        useEditBaselineStore.getState();
      const resolved: FileEntry[] = await Promise.all(
        seeds.map(async (entry) => {
          try {
            // "Before" = the recorded pre-edit baseline when one exists —
            // never live disk — so counts stay truthful after the edit
            // applies. This card renders ONE MESSAGE's edit chain, so
            // prefer the per-call baseline of this run's first edit of the
            // path (content immediately before the turn) over the
            // conversation-level first-wins baseline — a file re-edited in
            // a later turn must not replay a partial chain on pre-turn-1
            // content. Disk is only the fallback for legacy sessions with
            // no recorded baseline.
            const callBaseline = getToolCallBaseline(entry.group.firstToolCallId);
            const baseline =
              callBaseline && callBaseline.path === entry.path
                ? { content: callBaseline.content }
                : getBaseline(conversationId, entry.path);
            const original =
              baseline !== undefined
                ? baseline.content
                : ((await invoke<string | null>("read_file_for_diff", {
                    projectPath,
                    relPath: entry.path,
                  })) ?? null);
            // "After" = the transcript's edit chain replayed on the
            // baseline; when it can't be reproduced (Codex apply_patch),
            // the applied on-disk result is the truthful after.
            const newContent =
              materializeEdits(entry.group.edits, original) ??
              (await invoke<string | null>("read_file_for_diff", {
                projectPath,
                relPath: entry.path,
              })) ??
              "";
            const hasOriginal = original !== null && original.length > 0;
            const isEmptyNew = newContent.length === 0;
            let kind: FileKind;
            if (!hasOriginal) {
              kind = "new";
            } else if (isEmptyNew) {
              kind = "deleted";
            } else {
              kind = "modified";
            }
            const { added, removed } = countLineChanges(
              hasOriginal ? original : "",
              newContent,
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

  if (totalCount === 0) return null;

  if (grouped.new.length > 0) summaryParts.push(`${grouped.new.length} new`);
  if (grouped.modified.length > 0)
    summaryParts.push(`${grouped.modified.length} modified`);
  if (grouped.deleted.length > 0)
    summaryParts.push(`${grouped.deleted.length} deleted`);
  const summarySuffix =
    summaryParts.length > 0 ? `: ${summaryParts.join(", ")}` : "";

  const handleOpenAll = () => {
    useReviewStore.getState().openForConversation(conversationId);
  };

  const handleOpenFile = (path: string) => {
    if (/\.mdx?$/i.test(path)) {
      usePreviewPaneStore.getState().openMarkdown(path);
      return;
    }
    useReviewStore.getState().openForConversation(conversationId, path);
  };

  return (
    <div className="border border-bg-border rounded overflow-hidden bg-bg-secondary">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-2 py-1 hover:bg-bg-tertiary transition-colors text-left"
      >
        <ChevronRight
          size={12}
          className={`text-text-secondary shrink-0 transition-transform motion-reduce:transition-none ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <Folder size={12} className="text-accent-blue shrink-0" />
        <span className="text-[11px] text-text-primary flex-1 truncate">
          Edited {totalCount} {totalCount === 1 ? "file" : "files"}
          {summarySuffix}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-bg-border">
          <div className="max-h-64 overflow-y-auto">
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
                      <Spinner
                        size={11}
                        className="text-text-muted shrink-0"
                        label="Loading diff"
                      />
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
          </div>
          <div className="px-2 py-1.5 border-t border-bg-border bg-bg-primary flex justify-end">
            <button
              type="button"
              onClick={handleOpenAll}
              className="text-[11px] text-text-muted hover:text-text-primary transition-colors"
            >
              Review all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Memoized so a streaming turn's frequent store updates only re-render
// the card whose toolCall reference actually changed, not all 40+ at once.
export const MultiFileEditCard = memo(MultiFileEditCardImpl);
