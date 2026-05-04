import { Brain, FileEdit, TerminalSquare } from "lucide-react";
import { getActivityLabel } from "./activityLabel";

interface ActivityStripProps {
  state: string;
  tool: string | null;
  file: string | null;
}

export function ActivityStrip({ state, tool, file }: ActivityStripProps) {
  return (
    <div className="flex items-center gap-1.5 h-5 px-3 bg-bg-secondary border-t border-bg-border/50 text-[10px] text-text-muted">
      <ActivityIcon state={state} tool={tool} />
      <span className="truncate">
        {getActivityLabel(state, tool, file)}
      </span>
    </div>
  );
}

export function ActivityIcon({
  state,
  tool,
}: {
  state: string;
  tool: string | null;
}) {
  if (state === "thinking") {
    return <Brain size={10} className="text-accent-blue animate-pulse flex-shrink-0" />;
  }
  if (tool === "Edit" || tool === "Write") {
    return <FileEdit size={10} className="text-accent-amber flex-shrink-0" />;
  }
  if (tool === "Bash") {
    return <TerminalSquare size={10} className="text-accent-green flex-shrink-0" />;
  }
  return <FileEdit size={10} className="text-text-muted flex-shrink-0" />;
}

