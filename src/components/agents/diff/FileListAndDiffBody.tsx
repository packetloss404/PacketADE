import { useEffect, useMemo, useState } from "react";
import { FileDiff } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  aggregateConversationDiffs,
  type ConversationDiffAggregate,
  type PerFileDiffStat,
} from "@/lib/aggregateConversationDiffs";
import { aggregateWriteFiles } from "@/lib/diffUtils";
import type { AgentConversation } from "@/types/agent-conversation";
import { FileStats } from "./FileStats";
import { DiffBody } from "./DiffBody";
import { useReviewedDiffs } from "../hooks/useReviewedDiffs";

export interface FileListAndDiffBodyProps {
  conversation: AgentConversation | undefined;
  /**
   * Controlled selection. When omitted, the component manages selection
   * locally (used by the embedded inspector tab). When provided alongside
   * `onSelectFile`, the parent owns the selection (the slide-out routes it
   * through `useDiffPaneStore`).
   */
  selectedFilePath?: string | null;
  onSelectFile?: (path: string) => void;
  /** Forwarded to `<DiffBody>`. Defaults to false. */
  autoFormat?: boolean;
  /**
   * Empty-state message shown when the conversation has no `write_file`
   * tool calls yet.
   */
  emptyMessage?: string;
  /**
   * Reports the full per-conversation diff aggregate (file count + total
   * +adds/-dels) whenever it resolves, so the host pane header can surface
   * the totals. Fires with `null` while there is nothing to aggregate.
   */
  onAggregate?: (aggregate: ConversationDiffAggregate | null) => void;
}

/**
 * Shared body for the slide-out `DiffPane` and the inspector's
 * `EmbeddedDiffPane`. Owns the per-file list and the aggregate-stats query,
 * delegates the actual diff rendering to `DiffBody`. The list of files comes
 * from `aggregateWriteFiles(conversation)`; the +/- counts come from the
 * full `aggregateConversationDiffs` aggregate which reads disk for each
 * file.
 */
export function FileListAndDiffBody({
  conversation,
  selectedFilePath: selectedFilePathProp,
  onSelectFile,
  autoFormat = false,
  emptyMessage = "No file edits in this conversation yet.",
  onAggregate,
}: FileListAndDiffBodyProps) {
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

  // Uncontrolled selection fallback for callers that don't manage selection
  // themselves (the embedded inspector tab).
  const isControlled = selectedFilePathProp !== undefined;
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const selectedPath = isControlled ? selectedFilePathProp : internalSelected;
  // Mark the file's underlying `write_file` tool calls as reviewed when
  // the user selects it from the list — feeds the Diff-tab badge counter.
  const { markReviewed } = useReviewedDiffs(conversation?.id);
  // `markAsReviewed` defaults true for user-driven selection; the auto-select
  // effect passes false so merely opening the tab doesn't mark the first file
  // reviewed (which would inflate the reviewed count behind the user's back).
  const selectFile = (path: string, markAsReviewed = true) => {
    if (onSelectFile) onSelectFile(path);
    if (!isControlled) setInternalSelected(path);
    if (markAsReviewed) markReviewed(path);
  };

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
      onAggregate?.(null);
      return;
    }
    let cancelled = false;
    setAggregateLoading(true);
    (async () => {
      try {
        const result = await aggregateConversationDiffs(conversation);
        if (!cancelled) {
          setAggregate(result);
          onAggregate?.(result);
        }
      } catch {
        if (!cancelled) {
          setAggregate(null);
          onAggregate?.(null);
        }
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

  // Auto-select the first file when nothing valid is selected.
  useEffect(() => {
    if (entries.length === 0) return;
    if (!selectedPath || !writeFiles.has(selectedPath)) {
      selectFile(entries[0].path, false);
    }
    // selectFile is closure-stable enough for this purpose; including it
    // would loop because `internalSelected` setter re-creates the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, selectedPath, writeFiles]);

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState icon={<FileDiff size={24} />} title={emptyMessage} />
      </div>
    );
  }

  const activeEntry = selectedPath ? writeFiles.get(selectedPath) : undefined;

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: file list */}
      <div className="w-[180px] border-r border-bg-border overflow-y-auto bg-bg-secondary/50">
        <ul className="py-1">
          {entries.map((entry) => {
            const isActive = entry.path === selectedPath;
            const baseName = entry.path.split(/[\\/]/).pop() ?? entry.path;
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
                      ? "bg-accent-purple/15 border-l-2 border-accent-purple"
                      : "hover:bg-bg-hover border-l-2 border-transparent"
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
            autoFormat={autoFormat}
          />
        ) : (
          <div className="px-4 py-6 text-[11px] text-text-muted">
            Select a file to view its diff.
          </div>
        )}
      </div>
    </div>
  );
}
