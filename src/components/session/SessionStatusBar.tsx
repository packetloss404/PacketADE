import { ClaudeStatusBar } from "@/components/session/ClaudeStatusBar";
import { CodexStatusBar } from "@/components/session/CodexStatusBar";
import { OpenCodeStatusBar } from "@/components/session/OpenCodeStatusBar";

interface SessionStatusBarProps {
  cliCommand: string;
  alive: boolean;
  projectPath: string;
}

export function SessionStatusBar({ cliCommand, alive, projectPath }: SessionStatusBarProps) {
  if (!alive) return null;
  if (cliCommand === "claude") return <ClaudeStatusBar projectPath={projectPath} />;
  if (cliCommand === "codex") return <CodexStatusBar projectPath={projectPath} />;
  if (cliCommand === "opencode") return <OpenCodeStatusBar projectPath={projectPath} />;
  return null;
}
