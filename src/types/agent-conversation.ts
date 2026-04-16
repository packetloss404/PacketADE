import type { AgentCli } from "@/stores/agentTaskStore";

export interface AgentToolCall {
  id: string;
  name: string;
  file?: string;
  status: "running" | "done" | "error";
  /** Short preview (first ~200 chars) of the tool output for collapsed view. */
  summary?: string;
  /** Full tool output content. */
  fullContent?: string;
  /** Raw tool input (JSON string the model passed to the tool). */
  input?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: AgentToolCall[];
  isStreaming?: boolean;
  /** Whether this message was queued while the agent was running. */
  queued?: boolean;
  /** Input tokens consumed by this turn (assistant messages only). */
  inputTokens?: number;
  /** Output tokens produced by this turn (assistant messages only). */
  outputTokens?: number;
  /** Cached input tokens read on this turn. */
  cacheReadTokens?: number;
  /** Cached input tokens written on this turn. */
  cacheWriteTokens?: number;
}

export type AgentMode = "pty" | "api";

export interface AgentConversation {
  id: string;
  title: string;
  agent: AgentCli;
  projectPath: string;
  status: "active" | "idle" | "done" | "failed";
  messages: AgentMessage[];
  sessionId: string | null;
  rawOutput: string;
  createdAt: number;
  updatedAt: number;
  /** Whether this conversation uses PTY (CLI) or API mode. */
  mode: AgentMode;
  /** API provider (e.g., "anthropic", "openai"). Only set for API mode. */
  provider?: string;
  /** Model identifier (e.g., "claude-sonnet-4-6-20250414"). Only set for API mode. */
  model?: string;
  /** Optional system prompt override. Only set for API mode. */
  systemPromptOverride?: string | null;
  /** Messages queued while the agent was running. Drained when status returns to idle. */
  queuedMessages?: string[];
}
