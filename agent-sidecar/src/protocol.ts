// Shared wire protocol between the PacketADE Rust supervisor and this sidecar.
// The supervisor reads/writes newline-delimited JSON; every line is one of
// these envelopes. Do not change field names / types without updating the
// Rust side in lockstep.

// Bumped when the wire protocol changes in a way the supervisor must notice.
// Keep in lockstep with `EXPECTED_PROTOCOL_VERSION` in
// `src-tauri/src/commands/agent_sidecar.rs`.
//
// v2 (Tier 3 slice B): added `set_permission_mode`, `set_model`, and `retry`
// request types. Old sidecar builds reply with "Unknown request type" to
// these, so the version bump signals the capability requirement.
export const PROTOCOL_VERSION = 2;

export type StartSessionRequest = {
  type: "start_session";
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: Record<string, unknown>;
  projectPath: string;
  initialMessage: string;
  resume?: string;
  thinkingEnabled?: boolean;
  planMode?: boolean;
};

export type SendMessageRequest = {
  type: "send_message";
  sessionId: string;
  content: string;
  attachments?: unknown[];
};

export type PermissionResponseRequest = {
  type: "permission_response";
  sessionId: string;
  toolUseId: string;
  decision: "approve" | "deny";
};

export type EditResponseRequest = {
  type: "edit_response";
  sessionId: string;
  approved: boolean;
};

export type CancelRequest = {
  type: "cancel";
  sessionId: string;
};

export type CloseSessionRequest = {
  type: "close_session";
  sessionId: string;
};

// Protocol v2 additions — previously stubbed on the Rust side. Slice B wires
// them through the sidecar end-to-end; slice C adds the Rust forwarders.
//
// `mode` values mirror the Anthropic SDK's `PermissionMode`. The Codex
// provider maps them onto its sandbox/approval flags (see openai-codex.ts).
export type SetPermissionModeRequest = {
  type: "set_permission_mode";
  sessionId: string;
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";
};

export type SetModelRequest = {
  type: "set_model";
  sessionId: string;
  model: string;
};

export type RetryRequest = {
  type: "retry";
  sessionId: string;
};

export type SidecarRequest =
  | StartSessionRequest
  | SendMessageRequest
  | PermissionResponseRequest
  | EditResponseRequest
  | CancelRequest
  | CloseSessionRequest
  | SetPermissionModeRequest
  | SetModelRequest
  | RetryRequest;

export type SidecarEvent =
  | { type: "chunk"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "thinking_stop"; sessionId: string }
  | { type: "tool_start"; sessionId: string; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; sessionId: string; toolUseId: string; output: string; isError: boolean }
  | { type: "permission_request"; sessionId: string; toolUseId: string; name: string; input: unknown }
  | { type: "pending_edit"; sessionId: string; path: string; before: string; after: string }
  | { type: "done"; sessionId: string; inputTokens: number; outputTokens: number }
  | { type: "error"; sessionId: string; message: string }
  | { type: "ready"; pid: number; version: string; protocolVersion: number };

export type Emit = (event: SidecarEvent) => void;
