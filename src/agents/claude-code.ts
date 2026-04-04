import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

export const CLAUDE_CODE_CONFIG: AgentConfig = {
  id: "claude-code",
  name: "Claude Code",
  command: "claude",
  defaultArgs: [],
  description: "Anthropic's CLI coding agent. Supports Opus, Sonnet, and Haiku models.",
  installed: false,
  capabilities: ["code_edit", "code_review", "testing", "research", "shell", "refactor"],
  icon: "Bot",
  color: "text-accent-purple",
  statusPatterns: {
    approval: [
      "Allow\\s+\\w+.*\\?",
      "\\(y\\/n\\)",
      "Do you want to (?:proceed|continue|allow)",
      "Press\\s+y\\s+to\\s+(?:approve|allow|confirm)",
      "\\[Y\\/n\\]",
      "\\[y\\/N\\]",
      "Allow once|Allow always|Deny",
    ],
    thinking: [
      "⏺\\s*Thinking",
      "thinking\\.\\.\\.",
    ],
    toolUse: [
      { pattern: "⏺\\s*Read\\(([^)]+)\\)", tool: "Read", fileGroup: 1 },
      { pattern: "⏺\\s*Edit\\(([^)]+)\\)", tool: "Edit", fileGroup: 1 },
      { pattern: "⏺\\s*Write\\(([^)]+)\\)", tool: "Write", fileGroup: 1 },
      { pattern: "⏺\\s*Bash\\(([^)]*)\\)", tool: "Bash", fileGroup: 1 },
      { pattern: "⏺\\s*Glob\\(([^)]*)\\)", tool: "Glob", fileGroup: 1 },
      { pattern: "⏺\\s*Grep\\(([^)]*)\\)", tool: "Grep", fileGroup: 1 },
      { pattern: "⏺\\s*Task\\(([^)]*)\\)", tool: "Task", fileGroup: 1 },
      { pattern: "Reading\\s+(.+)", tool: "Read", fileGroup: 1 },
      { pattern: "Editing\\s+(.+)", tool: "Edit", fileGroup: 1 },
      { pattern: "Writing\\s+(.+)", tool: "Write", fileGroup: 1 },
      { pattern: "Running\\s+(.+)", tool: "Bash", fileGroup: 1 },
    ],
    idle: [
      "^\\s*[>❯]\\s*$",
    ],
  },
  isBuiltin: true,
};

export function createClaudeCodeAdapter(config?: Partial<AgentConfig>): AgentAdapter {
  const merged = { ...CLAUDE_CODE_CONFIG, ...config };
  const base = createBaseAdapter(merged);

  return {
    ...base,

    buildLaunchArgs(taskDescription: string, model?: string) {
      const args = [...merged.defaultArgs];
      if (model) {
        args.push("--model", model);
      }
      // Claude Code accepts initial prompt via -p flag or stdin
      if (taskDescription) {
        args.push("-p", taskDescription);
      }
      return { command: merged.command, args };
    },

    approveAction() {
      return "y\n";
    },

    denyAction() {
      return "n\n";
    },
  };
}
