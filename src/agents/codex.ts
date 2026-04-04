import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

export const CODEX_CONFIG: AgentConfig = {
  id: "codex",
  name: "Codex CLI",
  command: "codex",
  defaultArgs: [],
  description: "OpenAI's CLI coding agent. Supports GPT-5 series models.",
  installed: false,
  capabilities: ["code_edit", "code_review", "testing", "shell", "refactor"],
  icon: "Cpu",
  color: "text-accent-blue",
  statusPatterns: {
    approval: [
      "Allow\\s+\\w+.*\\?",
      "\\(y\\/n\\)",
      "Do you want to (?:proceed|continue|allow)",
      "\\[Y\\/n\\]",
      "\\[y\\/N\\]",
    ],
    thinking: [
      "thinking\\.\\.\\.",
      "Thinking",
    ],
    toolUse: [
      { pattern: "Reading\\s+(.+)", tool: "Read", fileGroup: 1 },
      { pattern: "Editing\\s+(.+)", tool: "Edit", fileGroup: 1 },
      { pattern: "Writing\\s+(.+)", tool: "Write", fileGroup: 1 },
      { pattern: "Running\\s+(.+)", tool: "Bash", fileGroup: 1 },
      { pattern: "Applying\\s+patch", tool: "Patch" },
    ],
    idle: [
      "^\\s*[>❯\\$]\\s*$",
    ],
  },
  isBuiltin: true,
};

export function createCodexAdapter(config?: Partial<AgentConfig>): AgentAdapter {
  const merged = { ...CODEX_CONFIG, ...config };
  const base = createBaseAdapter(merged);

  return {
    ...base,

    buildLaunchArgs(taskDescription: string, model?: string) {
      const args = [...merged.defaultArgs];
      if (model) {
        args.push("--model", model);
      }
      if (taskDescription) {
        args.push(taskDescription);
      }
      return { command: merged.command, args };
    },
  };
}
