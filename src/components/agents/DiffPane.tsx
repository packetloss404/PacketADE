import { useEffect, useMemo, useState } from "react";
import { X, FileDiff } from "lucide-react";
import { useDiffPaneStore } from "@/stores/diffPaneStore";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { aggregateWriteFiles } from "@/lib/diffUtils";
import type { ConversationDiffAggregate } from "@/lib/aggregateConversationDiffs";
import { FileListAndDiffBody } from "./diff/FileListAndDiffBody";

/**
 * Right-side slide-out diff pane. Thin wrapper around `FileListAndDiffBody`
 * that adds fixed-position chrome (the panel itself + close button) and
 * `useDiffPaneStore.open` gating. Selection is routed through the store so
 * external triggers (e.g. `MultiFileEditCard`) can deep-link to a specific
 * file when they open the pane.
 */
export function DiffPane() {
  const { open, conversationId, selectedFilePath, close, selectFile } =
    useDiffPaneStore();

  const conversation = useAgentTaskStore((s) =>
    conversationId
      ? s.conversations.find((c) => c.id === conversationId)
      : undefined,
  );

  // Header file count mirrors the same source the body uses.
  const fileCount = useMemo(
    () => aggregateWriteFiles(conversation).size,
    [conversation],
  );

  // Aggregate +adds/-dels lifted from the body so the header keeps the totals
  // the trigger chip advertised.
  const [aggregate, setAggregate] = useState<ConversationDiffAggregate | null>(
    null,
  );

  // Escape closes the slide-out, matching the app's overlay convention.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed top-0 right-0 h-full w-[480px] bg-bg-primary border-l border-bg-border shadow-2xl z-40 flex flex-col"
      role="complementary"
      aria-label="File changes diff pane"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border bg-bg-secondary">
        <div className="flex items-center gap-2">
          <FileDiff size={14} className="text-text-secondary" />
          <span className="text-xs font-medium text-text-primary">
            Changes ({fileCount} {fileCount === 1 ? "file" : "files"})
          </span>
          {aggregate && (
            <span className="flex items-center gap-1 text-[10px] font-mono">
              <span className="text-accent-green">+{aggregate.totalAdds}</span>
              <span className="text-accent-red">-{aggregate.totalDels}</span>
            </span>
          )}
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

      <FileListAndDiffBody
        conversation={conversation}
        selectedFilePath={selectedFilePath}
        onSelectFile={selectFile}
        onAggregate={setAggregate}
        autoFormat
      />
    </div>
  );
}
