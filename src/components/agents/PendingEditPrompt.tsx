import { FileEdit, Check, X } from "lucide-react";
import { ToolDiffView } from "./ToolDiffView";

interface PendingEditPromptProps {
  item: { id: string; path: string; content: string };
  projectPath: string;
  onApply: (toolId: string) => void;
  onReject: (toolId: string) => void;
}

export function PendingEditPrompt({ item, projectPath, onApply, onReject }: PendingEditPromptProps) {
  return (
    <div className="bg-bg-secondary border border-accent-amber/40 rounded p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <FileEdit size={14} className="text-accent-amber shrink-0" />
        <span className="text-xs text-text-primary font-mono truncate" title={item.path}>
          {item.path}
        </span>
      </div>
      <div className="max-h-64 overflow-auto">
        <ToolDiffView projectPath={projectPath} filePath={item.path} newContent={item.content} />
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onApply(item.id)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-green/40 text-accent-green hover:bg-accent-green/10"
        >
          <Check size={12} /> Apply
        </button>
        <button
          type="button"
          onClick={() => onReject(item.id)}
          className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10"
        >
          <X size={12} /> Reject
        </button>
      </div>
    </div>
  );
}
