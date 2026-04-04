import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createBaseAdapter } from "./types";

/**
 * Creates a default AgentConfig for a custom/unknown CLI agent.
 * Only basic exit detection — no state parsing.
 */
export function createGenericConfig(
  id: string,
  name: string,
  command: string,
  description?: string
): AgentConfig {
  return {
    id,
    name,
    command,
    defaultArgs: [],
    description: description || `Custom CLI agent: ${command}`,
    installed: false,
    capabilities: [],
    icon: "TerminalSquare",
    color: "text-text-muted",
    statusPatterns: {
      approval: [
        "\\(y\\/n\\)",
        "\\[Y\\/n\\]",
        "\\[y\\/N\\]",
      ],
      thinking: [],
      toolUse: [],
      idle: [
        "^\\s*[>❯\\$#]\\s*$",
      ],
    },
    isBuiltin: false,
  };
}

export function createGenericAdapter(config: AgentConfig): AgentAdapter {
  return createBaseAdapter(config);
}
