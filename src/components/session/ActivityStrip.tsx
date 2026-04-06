import { Brain, FileEdit, TerminalSquare } from "lucide-react";

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

export function getActivityLabel(
  state: string,
  tool: string | null,
  file: string | null
): string {
  if (state === "thinking") return "Thinking...";

  if (!tool) return "";

  const shortFile = file
    ? file.length > 50
      ? "..." + file.slice(-47)
      : file
    : "";

  switch (tool) {
    case "Edit":
      return `Editing ${shortFile}`;
    case "Write":
      return `Writing ${shortFile}`;
    case "Read":
      return `Reading ${shortFile}`;
    case "Bash":
      return `Running: ${shortFile}`;
    case "Glob":
      return `Searching: ${shortFile}`;
    case "Grep":
      return `Searching: ${shortFile}`;
    case "Task":
      return `Running task: ${shortFile}`;
    default:
      return `${tool} ${shortFile}`;
  }
}
