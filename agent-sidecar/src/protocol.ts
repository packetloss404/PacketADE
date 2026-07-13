// Shared wire protocol between the PacketADE Rust supervisor and this sidecar.
// The supervisor reads/writes newline-delimited JSON; every line is one of
// these envelopes. Do not change field names / types without updating the
// Rust side in lockstep.

// Bumped when the wire protocol changes in a way the supervisor must notice.
// Keep in lockstep with `EXPECTED_PROTOCOL_VERSION` in
// `src-tauri/src/commands/agent_sidecar/mod.rs`.
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
//
// v5 (Flight Planner E1): adds
//   - `inject_user_turn` request: typed wake-trigger/user-turn injection
//     into a long-lived session, used by the autonomous Flight Planner
//     wake bus and (eventually) the spec-mode chat path.
//   (v5 also shipped an in-process planner MCP surface — `planner_tool`
//   event, `planner_tool_result` request, and `StartSessionRequest.mcpKind`
//   — all removed in v7 when the Rust planner backend was amputated.)
//
// v6 (Flight Planner E6 — rate-limit handler): adds the `rate_limited`
// sidecar event. The Anthropic provider catches `RateLimitError` from the
// Claude Agent SDK's message iterator, parses the `retry-after` header
// when present, and emits this typed event alongside its existing `error`
// emit. The Rust supervisor routes the event into
// `FlightPlannerRegistry::on_rate_limited`, which flips the owning
// planner's status to `QuotaPaused`, schedules an auto-resume timer
// (clamped to 60-600s), and emits a per-flight Tauri event the frontend
// turns into an OS-level desktop notification.
//
// v7 (planner amputation): removes the in-process planner MCP surface —
// the `planner_tool` event, the `planner_tool_result` request, and
// `StartSessionRequest.mcpKind`. The Rust planner backend was deleted in
// C2-S1, so the sidecar no longer emits or accepts planner envelopes.
// `inject_user_turn` (shared re-entry) and `rate_limited` (generic 429
// surface) survive. Negotiation stays warn-only, so an old supervisor
// paired with a v7 sidecar (or vice versa) still connects.
export const PROTOCOL_VERSION = 7;

/** Image content a model can interpret natively. base64-encoded bytes. */
export type ImageAttachment = {
  media_type: string;
  data_base64: string;
};

export type ResumeMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type PermissionMode = "auto" | "ask_for_risky" | "allow_all" | "deny_all";

export type WorkspaceRef =
  | {
      kind: "local";
      projectPath: string;
    }
  | {
      kind: "ssh";
      serverId?: string | null;
      host: string;
      port: number;
      user: string;
      remotePath: string;
      keyPath?: string | null;
      authMethod?: "agent" | "key" | "password" | null;
      hostFingerprint?: string | null;
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
  /** v4: API-key sidecar providers may receive a transient key from Rust.
   * This is never persisted by the frontend or sidecar. */
  apiKey?: string;
  resume?: string;
  thinkingEnabled?: boolean;
  planMode?: boolean;
  /** v3: image attachments inlined into the initial user message. */
  attachments?: ImageAttachment[];
  /** Persisted UI transcript used when a provider cannot resume from a
   * native session token, and as the seed for SDK memory sessions. */
  resumeMessages?: ResumeMessage[];
  permissionMode?: PermissionMode;
  approveWrites?: boolean;
  /** Optional absolute command path for CLI-backed providers. Currently used
   * by `openai-codex` so PacketADE can honor a user-pinned Codex binary
   * instead of relying on PATH resolution. */
  commandPath?: string;
  /** Structured workspace metadata. `projectPath` remains for v1/v6
   * compatibility with local sidecars; remote launches use this object to
   * avoid treating an SSH path as a local filesystem path. */
  workspace?: WorkspaceRef;
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
  decision: "approve" | "allow_once" | "allow_always" | "deny";
  /** P1-9 deny-and-continue: optional user steering text carried with a
   * "deny". Providers fold it into the denial message the model sees so a
   * rejection redirects the agent instead of stalling the turn. Ignored
   * for allow decisions. */
  reason?: string;
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
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | PermissionMode;
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

/** v4+: drain every parked permission_request / pending_edit prompt as
 * denied WITHOUT killing the agent loop. The model sees synthetic
 * "User cancelled this tool" tool_results and continues generating. Use
 * `cancel` (not this) when the user wants the whole session to stop. */
export type CancelPendingToolsRequest = {
  type: "cancel_pending_tools";
  sessionId: string;
};

/** v5: inject a new user turn into a long-lived session. Used by the
 * Flight Planner wake bus (`source: "wake_trigger"`) and the spec-mode
 * chat path (`source: "user"`). Wake-trigger content is wrapped in
 * `<wake_trigger source="..." kind="...">...</wake_trigger>` by the
 * provider so the system prompt can distinguish re-entry from a human
 * turn; user content is pushed verbatim. */
export type InjectUserTurnRequest = {
  type: "inject_user_turn";
  sessionId: string;
  content: string;
  source: "user" | "wake_trigger";
  /** Wake-trigger provenance — currently informational, threaded into the
   * `<wake_trigger>` envelope's `kind` attribute. Ignored when
   * `source === "user"`. */
  trigger?: { kind: string; payload?: unknown };
  /** E6-CAPS: per-mode output `max_tokens` budget the Flight Planner wants
   * the provider to honor for this turn. The Claude Agent SDK (0.2.116) does
   * not expose a per-turn `max_tokens` setter, so the anthropic provider
   * currently logs a warning and falls back to the SDK's defaults. The
   * field is still threaded through so future SDK versions can pick it up
   * without another protocol change. */
  maxOutputTokens?: number;
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
  | CancelPendingToolsRequest
  | InjectUserTurnRequest;

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
  | { type: "tool_start"; sessionId: string; toolUseId: string; name: string; input?: unknown }
  | {
      type: "tool_result";
      sessionId: string;
      toolUseId: string;
      output: string;
      isError: boolean;
      name?: string;
      input?: unknown;
    }
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
  | {
      type: "pending_edit";
      sessionId: string;
      toolUseId?: string;
      path: string;
      before?: string;
      after: string;
    }
  /** P1-7: non-blocking pre-edit baseline capture. Emitted for every
   * edit-bearing tool call that does NOT go through the blocking
   * `pending_edit` approval flow (approveWrites off), so the host can diff
   * applied edits against the true pre-edit content instead of live disk.
   * `before` is absent when the file did not exist. */
  | {
      type: "edit_baseline";
      sessionId: string;
      toolUseId?: string;
      path: string;
      before?: string;
    }
  | {
      type: "done";
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
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
      /** Reasoning tokens (Codex 0.125+ exposes `usage.reasoning_tokens`,
       * OpenAI o-series). Billed at the OUTPUT rate. */
      reasoningTokens?: number;
      /** A3: Codex MultiAgentV2 sub-agent path address (e.g. `/root/agent_a`).
       * When present, the host attributes these tokens to a per-address
       * bucket on the conversation instead of accumulating to the root —
       * otherwise multi-agent flights would inflate the root's totals by
       * the children's spend. Empty/absent = root thread. */
      address?: string;
    }
  // v6 additions ----------------------------------------------------------
  /** Flight Planner E6: the underlying provider returned a rate-limit
   * error (HTTP 429 in Anthropic's case). Emitted IN ADDITION to the
   * regular `error` event so legacy listeners still react. The Rust
   * supervisor consumes this in `agent_sidecar::handle_event` and
   * delegates to `FlightPlannerRegistry::on_rate_limited`, which arms
   * the QuotaPaused backoff window. `retryAfterSeconds` is parsed from
   * the SDK error's `retry-after` header when present (Anthropic returns
   * a number-of-seconds value); the field is omitted when the header is
   * absent so the Rust side can fall back to a default window. */
  | {
      type: "rate_limited";
      sessionId: string;
      retryAfterSeconds?: number;
      message?: string;
    };

/** Wire shape for `rate_limited` (typed so the Anthropic provider and the
 * Rust supervisor can import a single name rather than re-spelling the
 * inline union arm). v6. */
export type RateLimitedEvent = Extract<SidecarEvent, { type: "rate_limited" }>;

export type Emit = (event: SidecarEvent) => void;
