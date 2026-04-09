import { ClaudeStatusBar } from "@/components/session/ClaudeStatusBar";
import { CodexStatusBar } from "@/components/session/CodexStatusBar";

interface SessionStatusBarProps {
  cliCommand: string;
  alive: boolean;
  projectPath: string;
}

const CLI_LABELS: Record<string, string> = {
  gemini: "Gemini CLI",
  opencode: "OpenCode",
};

export function SessionStatusBar({ cliCommand, alive, projectPath }: SessionStatusBarProps) {
  if (!alive) return null;
  if (cliCommand === "claude") return <ClaudeStatusBar projectPath={projectPath} />;
  if (cliCommand === "codex") return <CodexStatusBar projectPath={projectPath} />;

  const label = CLI_LABELS[cliCommand];
  if (label) {
    return (
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] text-text-muted border-t border-bg-border bg-bg-secondary">
        <span className="text-accent-green font-medium">{label}</span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
          running
        </span>
      </div>
    );
  }

  return null;
}
