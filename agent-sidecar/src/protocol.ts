// Shared wire protocol between the PacketADE Rust supervisor and this sidecar.
// The supervisor reads/writes newline-delimited JSON; every line is one of
// these envelopes. Do not change field names / types without updating the
// Rust side in lockstep.

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

export type SidecarRequest =
  | StartSessionRequest
  | SendMessageRequest
  | PermissionResponseRequest
  | EditResponseRequest
  | CancelRequest
  | CloseSessionRequest;

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
  | { type: "ready"; pid: number };

export type Emit = (event: SidecarEvent) => void;
