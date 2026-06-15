import { useMemo } from "react";
import { FileDiff } from "lucide-react";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { aggregateWriteFiles } from "@/lib/diffUtils";
import { FileListAndDiffBody } from "./diff/FileListAndDiffBody";

interface EmbeddedDiffPaneProps {
  conversationId: string;
}

/**
 * Embeddable variant of DiffPane used inline by the AgentInspectorPane's
 * Diff tab. Same per-file diff browser, minus the fixed-position chrome and
 * the open-state store coupling — selection is managed internally by
 * `FileListAndDiffBody`.
 */
export function EmbeddedDiffPane({ conversationId }: EmbeddedDiffPaneProps) {
  const conversation = useAgentTaskStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );

  const fileCount = useMemo(
    () => aggregateWriteFiles(conversation).size,
    [conversation],
  );

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bg-border bg-bg-secondary shrink-0">
        <FileDiff size={12} className="text-text-secondary" />
        <span className="text-[11px] font-medium text-text-primary">
          Changes ({fileCount} {fileCount === 1 ? "file" : "files"})
        </span>
      </div>

      <FileListAndDiffBody conversation={conversation} />
    </div>
  );
}
