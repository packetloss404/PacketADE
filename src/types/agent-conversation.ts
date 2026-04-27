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

/** How much detail to show in the transcript renderer. */
export type TranscriptVerbosity = "summary" | "normal" | "verbose";

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
  /** Pending permission prompts awaiting user decision. */
  pendingPermissions?: PendingPermission[];
  /** Pending write-file edits awaiting user decision. */
  pendingEdits?: PendingEdit[];
  /** Extended-thinking (Anthropic) enabled for this session. */
  thinkingEnabled?: boolean;
  /** Accumulating thinking text during the current streaming turn. */
  thinkingStream?: string;
  /** Set when this conversation's tool calls execute on a remote host via SSH. */
  sshTarget?: {
    id: string;
    name: string;
    host: string;
    user: string;
    remotePath: string;
  };
  /** Per-conversation render density. Default = "normal". */
  transcriptVerbosity?: TranscriptVerbosity;
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
  /** Soft binding to a Workspace (see workspaceStore). Set when the conversation
   * was created from inside a Workspace context (WorkspacePane or flight attempt).
   * Cleared if the parent Workspace is archived/deleted. Drives the optional
   * "workspace" sidebar group mode. */
  workspaceId?: string;
}
