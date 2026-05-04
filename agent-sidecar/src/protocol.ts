// Shared wire protocol between the PacketADE Rust supervisor and this sidecar.
// The supervisor reads/writes newline-delimited JSON; every line is one of
// these envelopes. Do not change field names / types without updating the
// Rust side in lockstep.

// Bumped when the wire protocol changes in a way the supervisor must notice.
// Keep in lockstep with `EXPECTED_PROTOCOL_VERSION` in
// `src-tauri/src/commands/agent_sidecar.rs`.
//
// v2 (Tier 3 slice B): added `set_permission_mode`, `set_model`, and `retry`
// request types.
//
// v3 (PacketADE Tier 3 slice A): adds first-class `attachments` on
// start/send, `mergedContent` on edit_response (per-hunk acceptance),
// `batchId`/`batchSize` on permission_request, and three new events:
// `plan_block` (structured TodoWrite mirror), `tool_output_extended`
// (exit code + modified paths), `turn_summary` (running tokens between
// turns). Old sidecars reply "Unknown request type" to v3-only requests,
// so the supervisor warns on version mismatch (does not refuse).
//
// v4 (F8): adds `cancel_pending_tools` request — drain parked
// permission/edit prompts as denied without killing the agent loop.
export const PROTOCOL_VERSION = 4;

/** Image content a model can interpret natively. base64-encoded bytes. */
export type ImageAttachment = {
  media_type: string;
  data_base64: string;
};

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
  /** v3: image attachments inlined into the initial user message. */
  attachments?: ImageAttachment[];
};

export type SendMessageRequest = {
  type: "send_message";
  sessionId: string;
  content: string;
  /** v3: typed attachments (was unknown[]). */
  attachments?: ImageAttachment[];
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
  /** v3: when set, the provider should write this content instead of the
   * tool's original `content`. Used by per-hunk diff acceptance — the
   * frontend sends a merged result keeping only the hunks the user picked. */
  mergedContent?: string;
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

/** v3+: drain every parked permission_request / pending_edit prompt as
 * denied WITHOUT killing the agent loop. The model sees synthetic
 * "User cancelled this tool" tool_results and continues generating. Use
 * `cancel` (not this) when the user wants the whole session to stop. */
export type CancelPendingToolsRequest = {
  type: "cancel_pending_tools";
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
  | RetryRequest
  | CancelPendingToolsRequest;

/** v3: structured todo/plan item produced by Anthropic's TodoWrite tool. */
export type PlanItem = {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

export type SidecarEvent =
  | { type: "chunk"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "thinking_stop"; sessionId: string }
  | { type: "tool_start"; sessionId: string; toolUseId: string; name: string; input: unknown }
  | { type: "tool_result"; sessionId: string; toolUseId: string; output: string; isError: boolean }
  | {
      type: "permission_request";
      sessionId: string;
      toolUseId: string;
      name: string;
      input: unknown;
      /** v3: when the provider knows multiple permission requests are about
       * to land in the same logical batch, set these so the UI can offer an
       * "approve all N" rollup with the right denominator. */
      batchId?: string;
      batchSize?: number;
    }
  | { type: "pending_edit"; sessionId: string; path: string; before: string; after: string }
  | {
      type: "done";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      /** v3: opaque token the supervisor can persist and re-send via
       * StartSessionRequest.resume to continue this conversation after a
       * cold start. Provider-defined; treated as a black box by the host. */
      resumeToken?: string;
    }
  | { type: "error"; sessionId: string; message: string }
  | { type: "ready"; pid: number; version: string; protocolVersion: number }
  // v3 additions ----------------------------------------------------------
  | {
      type: "plan_block";
      sessionId: string;
      items: PlanItem[];
    }
  | {
      type: "tool_output_extended";
      sessionId: string;
      toolUseId: string;
      exitCode?: number;
      modifiedPaths?: string[];
      stdout?: string;
      stderr?: string;
    }
  | {
      type: "turn_summary";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    };

export type Emit = (event: SidecarEvent) => void;
