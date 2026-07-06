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
  /** v3 / F5: structured tool metadata from `tool_output_extended`. */
  exitCode?: number;
  modifiedPaths?: string[];
  stdout?: string;
  stderr?: string;
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
  /** Reasoning tokens (Codex 0.125+ via `usage.reasoning_tokens`,
   * OpenAI o-series). Billed at the OUTPUT rate by every provider that
   * exposes them — counted alongside outputTokens in cost math. */
  reasoningTokens?: number;
  /** Estimated USD cost of this turn, stamped at receipt time from the
   * frontend pricing table (see conversationCost.estimateTurnCostUsd).
   * Absent when the model has no pricing entry. */
  costUsd?: number;
  /** Extended thinking text produced by this turn (Anthropic). */
  thinking?: string;
}

export type PermissionMode = "auto" | "ask_for_risky" | "allow_all" | "deny_all";

export interface PendingPermission {
  id: string;
  name: string;
  arguments: string;
}

export interface PendingEdit {
  id: string;
  path: string;
  content: string;
  /** Prior file content (undefined for new files). Drives red/green diff render. */
  before?: string;
}

export type AgentMode = "pty" | "api";

/** v3: structured plan/todo item, mirrors the Anthropic SDK's TodoWrite
 * payload shape. Surfaced via the `api-agent:plan-block:*` event. */
export interface AgentPlanItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** B1: Codex-App-style hover-`+` diff comment. Anchors a free-text note
 * to a specific line of a pending edit. Queued on the conversation;
 * folded into the next user turn as a "File comments:" preamble and
 * cleared on send. `side` distinguishes anchors on the old (removed)
 * vs new (added/context) version of the file. */
export interface DiffComment {
  id: string;
  path: string;
  line: number;
  side: "old" | "new";
  text: string;
  createdAt: number;
}

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
  /** Plan mode active — write_file and bash are disabled. */
  planMode?: boolean;
  /** Permission mode for risky tool calls. */
  permissionMode?: PermissionMode;
  /** Require user approval before each write_file. */
  approveWrites?: boolean;
  /** Extended-thinking (Anthropic) enabled for this session. */
  thinkingEnabled?: boolean;
  /** Set when this conversation's tool calls execute on a remote host via SSH. */
  sshTarget?: {
    id: string;
    name: string;
    host: string;
    user: string;
    remotePath: string;
  };
  /** Whether this conversation is archived. Archived conversations are hidden from
   * the sidebar by default but accessible via the "Archived" filter. Treat
   * undefined as false. */
  archived?: boolean;
  /** Restrict this conversation's agent to this tool subset. Undefined = all tools.
   * Populated from the selected profile's `allowedTools` at conversation creation. */
  allowedTools?: string[];
  /** Inject project-memory context into the system prompt for this conversation.
   * Default true for conversations opened with read-only profiles (e.g. Scout),
   * false otherwise. Toggleable from the chat header. */
  memoryContextEnabled?: boolean;
  /** v3: opaque resume token captured from the provider's `done` event.
   * When set on a hydrated conversation, the next launch reuses it via
   * `start_api_agent_session.resume`. */
  resumeToken?: string;
  /** F9: subset of MCP server names enabled for THIS conversation.
   * `undefined` = all non-disabled servers (back-compat). Names match
   * `McpServerEntry.name` from `useMcpStore`. Sidecar protocol has no
   * mid-session MCP swap, so flips here apply on the NEXT session start. */
  enabledMcpServerIds?: string[];
  /** B1: hover-`+` diff comments queued by the user on pending edits.
   * Folded into the next user turn as a "File comments:" preamble and
   * cleared on send (or via the chip-strip "Clear" action). */
  pendingDiffComments?: DiffComment[];
  /** B8: when this conversation was spawned by a "Hand off to Codex"
   * action from another conversation, the parent's id. Drives the
   * "← back to plan" link in the chat header. Undefined for normal
   * standalone conversations. */
  parentConversationId?: string;
}
