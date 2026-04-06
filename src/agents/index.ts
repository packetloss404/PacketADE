export { CLAUDE_CODE_CONFIG, createClaudeCodeAdapter } from "./claude-code";
export { OPENCODE_CONFIG, createOpenCodeAdapter } from "./opencode";
export { CODEX_CONFIG, createCodexAdapter } from "./codex";
export { GEMINI_CONFIG, createGeminiAdapter } from "./gemini";
export { TERMINAL_CONFIG, createTerminalAdapter } from "./terminal";
export { createGenericConfig, createGenericAdapter } from "./generic";
export { createBaseAdapter, createPatternParser, stripAnsi } from "./types";
export type { AgentAdapter, AgentConfig, AgentStateUpdate } from "./types";

import type { AgentConfig, AgentAdapter } from "@/types/agent";
import { createClaudeCodeAdapter } from "./claude-code";
import { createOpenCodeAdapter } from "./opencode";
import { createCodexAdapter } from "./codex";
import { createGeminiAdapter } from "./gemini";
import { createTerminalAdapter } from "./terminal";
import { createGenericAdapter } from "./generic";

/**
 * Get the appropriate adapter for an agent config.
 * Uses the built-in adapter for known agents, falls back to generic.
 */
export function getAdapterForAgent(config: AgentConfig): AgentAdapter {
  switch (config.id) {
    case "claude-code":
      return createClaudeCodeAdapter(config);
    case "opencode":
      return createOpenCodeAdapter(config);
    case "codex":
      return createCodexAdapter(config);
    case "gemini":
      return createGeminiAdapter(config);
    case "terminal":
      return createTerminalAdapter(config);
    default:
      return createGenericAdapter(config);
  }
}
