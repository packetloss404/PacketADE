import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

export const PACKETCODE_CONFIG: AgentConfig = {
  id: "packetcode",
  name: "PacketCode",
  command: "packetcode",
  defaultArgs: [],
  description:
    "Keyboard-first multi-provider terminal coding agent (sibling project). OpenAI/Anthropic/Gemini/MiniMax/OpenRouter/Ollama with approval flow.",
  installed: false,
  capabilities: [
    "code_edit",
    "code_review",
    "testing",
    "research",
    "shell",
    "refactor",
  ],
  icon: "Terminal",
  color: "text-accent-purple",
  statusPatterns: {
    approval: [
      "\\[Y\\/n\\]",
      "\\[y\\/N\\]",
      "\\(y\\/n\\)",
      "Approve|Reject",
      "Do you want to (?:proceed|continue|allow)",
    ],
    thinking: ["thinking", "Thinking", "reasoning"],
    toolUse: [
      { pattern: "Reading\\s+(.+)", tool: "Read", fileGroup: 1 },
      { pattern: "Editing\\s+(.+)", tool: "Edit", fileGroup: 1 },
      { pattern: "Writing\\s+(.+)", tool: "Write", fileGroup: 1 },
      { pattern: "Patching\\s+(.+)", tool: "Patch", fileGroup: 1 },
      { pattern: "Running\\s+(.+)", tool: "Bash", fileGroup: 1 },
      { pattern: "Searching\\s+(.+)", tool: "Search", fileGroup: 1 },
    ],
    idle: ["^\\s*[>❯\\$]\\s*$", "packetcode>"],
  },
  isBuiltin: true,
};

export function createPacketCodeAdapter(
  config?: Partial<AgentConfig>,
): AgentAdapter {
  const merged = { ...PACKETCODE_CONFIG, ...config };
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
