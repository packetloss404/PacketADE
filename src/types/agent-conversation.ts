import type { AgentCli } from "@/stores/agentTaskStore";

export interface AgentToolCall {
  id: string;
  name: string;
  file?: string;
  status: "running" | "done" | "error";
  summary?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: AgentToolCall[];
  isStreaming?: boolean;
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
}
