import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

export const GEMINI_CONFIG: AgentConfig = {
  id: "gemini",
  name: "Gemini CLI",
  command: "gemini",
  defaultArgs: [],
  description: "Google's CLI coding agent. Supports Gemini 2.5 Pro and Flash models.",
  installed: false,
  capabilities: ["code_edit", "code_review", "testing", "research", "shell", "refactor"],
  icon: "Sparkles",
  color: "text-accent-blue",
  statusPatterns: {
    approval: [
      "\\(y\\/n\\)",
      "\\[Y\\/n\\]",
      "\\[y\\/N\\]",
      "Do you want to (?:proceed|continue|allow)",
      "Allow\\s+\\w+.*\\?",
    ],
    thinking: [
      "Thinking",
      "thinking\\.\\.\\.",
      "Planning",
    ],
    toolUse: [
      { pattern: "Reading\\s+(.+)", tool: "Read", fileGroup: 1 },
      { pattern: "Editing\\s+(.+)", tool: "Edit", fileGroup: 1 },
      { pattern: "Writing\\s+(.+)", tool: "Write", fileGroup: 1 },
      { pattern: "Running\\s+(.+)", tool: "Bash", fileGroup: 1 },
      { pattern: "Searching\\s+(.+)", tool: "Search", fileGroup: 1 },
    ],
    idle: [
      "^\\s*[>❯\\$]\\s*$",
    ],
  },
  isBuiltin: true,
};

export function createGeminiAdapter(config?: Partial<AgentConfig>): AgentAdapter {
  const merged = { ...GEMINI_CONFIG, ...config };
  const base = createBaseAdapter(merged);

  return {
    ...base,

    buildLaunchArgs(taskDescription: string, model?: string) {
      const args = [...merged.defaultArgs];
      if (model) {
        args.push("--model", model);
      }
      if (taskDescription) {
        args.push("-p", taskDescription);
      }
      return { command: merged.command, args };
    },
  };
}
