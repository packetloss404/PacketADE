import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

export const TERMINAL_CONFIG: AgentConfig = {
  id: "terminal",
  name: "Terminal",
  command: isWindows ? "powershell" : "bash",
  defaultArgs: [],
  description: "Plain terminal shell. No AI agent — just a standard shell session.",
  installed: true,
  capabilities: ["shell"],
  icon: "TerminalSquare",
  color: "text-text-secondary",
  statusPatterns: {
    approval: [],
    thinking: [],
    toolUse: [],
    idle: [
      "^\\s*[>❯\\$#%]\\s*$",
      "PS [A-Z]:",
    ],
  },
  isBuiltin: true,
};

export function createTerminalAdapter(config?: Partial<AgentConfig>): AgentAdapter {
  const merged = { ...TERMINAL_CONFIG, ...config };
  const base = createBaseAdapter(merged);

  return {
    ...base,

    buildLaunchArgs(_taskDescription: string, _model?: string) {
      return { command: merged.command, args: [...merged.defaultArgs] };
    },

    formatPrompt(taskDescription: string) {
      return taskDescription;
    },
  };
}
