import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

export const OPENCODE_CONFIG: AgentConfig = {
  id: "opencode",
  name: "OpenCode",
  command: "opencode",
  defaultArgs: ["."],
  description: "Open-source AI coding agent. Supports 75+ LLM providers including OpenAI, Anthropic, Google, Ollama.",
  installed: false,
  capabilities: ["code_edit", "code_review", "testing", "research", "shell", "refactor"],
  icon: "Terminal",
  color: "text-accent-green",
  statusPatterns: {
    approval: [
      "\\(y\\/n\\)",
      "Approve|Cancel",
      "Do you want to (?:proceed|continue|allow)",
    ],
    thinking: [
      "thinking",
      "reasoning",
      "Planning",
    ],
    toolUse: [
      { pattern: "Reading\\s+(.+)", tool: "Read", fileGroup: 1 },
      { pattern: "Editing\\s+(.+)", tool: "Edit", fileGroup: 1 },
      { pattern: "Writing\\s+(.+)", tool: "Write", fileGroup: 1 },
      { pattern: "Running\\s+(.+)", tool: "Bash", fileGroup: 1 },
      { pattern: "Searching\\s+(.+)", tool: "Search", fileGroup: 1 },
      { pattern: "tool.*running", tool: "Tool" },
    ],
    idle: [
      "^\\s*[>❯\\$]\\s*$",
      "opencode>",
    ],
  },
  isBuiltin: true,
};

export function createOpenCodeAdapter(config?: Partial<AgentConfig>): AgentAdapter {
  const merged = { ...OPENCODE_CONFIG, ...config };
  const base = createBaseAdapter(merged);

  return {
    ...base,

    buildLaunchArgs(taskDescription: string, model?: string) {
      const args = [...merged.defaultArgs];
      if (model) {
        args.push("--model", model);
      }
      // OpenCode supports -p for non-interactive prompt mode
      if (taskDescription) {
        args.push("-p", taskDescription);
      }
      return { command: merged.command, args };
    },

    formatPrompt(taskDescription: string, context?: string) {
      // OpenCode uses its own context system; just pass the task
      let prompt = taskDescription;
      if (context) {
        prompt = `Context:\n${context}\n\nTask:\n${taskDescription}`;
      }
      return prompt;
    },
  };
}
