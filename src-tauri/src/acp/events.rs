//! ACP → `api-agent:*` translation.
//!
//! The bridge in [`super`] speaks raw Agent Client Protocol. PacketBench's
//! frontend speaks `api-agent:{kind}:{sessionId}` and cannot tell which
//! backend served a conversation. This module is the whole of the seam:
//!
//!  * [`AcpSessions`] holds the bidirectional conversation-id ↔ ACP-session-id
//!    map (PacketBench mints the conversation id; the engine mints its own on
//!    `session/new`), plus the per-conversation translation state a stream
//!    needs — whether a thinking run is open, which tool calls are in flight,
//!    and the raw JSON-RPC ids of unanswered permission requests.
//!  * [`translate_update`] / [`translate_permission_request`] are PURE: they
//!    take one ACP payload and return the `api-agent:*` emissions it implies.
//!    Every translation rule is unit-testable without a Tauri AppHandle.
//!  * [`ApiAgentSink`] is the thin `AcpEvents` impl that runs those functions
//!    and emits the results.
//!
//! Event names and payload shapes are reused verbatim from
//! `commands::agent_sidecar::events` — never re-derived here, so the three
//! backends cannot drift.

use crate::commands::agent_sidecar::events as api;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Session bookkeeping
// ---------------------------------------------------------------------------

/// One option the engine offered on a permission request, kept so a
/// PacketBench decision ("allow_once" / "allow_always" / "deny") can be matched
/// to the engine's own `optionId` instead of guessing at its spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    /// ACP option kind: allow_once | allow_always | reject_once | reject_always.
    pub kind: String,
}

/// One unanswered `session/request_permission`, as PacketBench sees it.
///
/// `id` is what went out on the `permission-request` payload (a String, per
/// the api-agent contract). `raw_id` is the JSON-RPC id exactly as the engine
/// wrote it — a STRING for a real packetcode engine
/// ("packetcode-permission-1"), a number for some other agent. The reply frame
/// must echo `raw_id` verbatim, which is why the stringified form is never
/// enough on its own.
#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub id: String,
    pub raw_id: Value,
    pub conversation_id: String,
    pub options: Vec<PermissionOption>,
}

impl PendingPermission {
    /// The engine `optionId` for a PacketBench decision, or `None` when the
    /// engine offered nothing of that shape.
    ///
    /// `allow_always` degrades to `allow_once` and `reject_always` to
    /// `reject_once` rather than failing: a one-shot approval is always the
    /// conservative reading of a "remember this" click the engine cannot
    /// honour.
    pub fn option_for(&self, decision: &str) -> Option<&str> {
        let preference: &[&str] = match decision {
            "allow_once" => &["allow_once", "allow_always"],
            "allow_always" => &["allow_always", "allow_once"],
            "deny" | "reject" | "reject_once" => &["reject_once", "reject_always"],
            "reject_always" => &["reject_always", "reject_once"],
            _ => return None,
        };
        for kind in preference {
            if let Some(hit) = self.options.iter().find(|o| o.kind == *kind) {
                return Some(&hit.option_id);
            }
        }
        // An engine that sent no `kind` at all: fall back to positional
        // convention (allow first, reject second), which is what the ACP
        // reference agents emit.
        let index = if preference[0].starts_with("allow") { 0 } else { 1 };
        self.options.get(index).map(|o| o.option_id.as_str())
    }
}

/// Metadata captured from a `tool_call` so the later `tool_call_update` can
/// be rendered as a complete `tool-result` — ACP updates carry only the id and
/// the status, never the name or the input that started the call.
#[derive(Debug, Clone, Default)]
struct ToolMeta {
    name: String,
    input: String,
}

/// Everything PacketBench tracks for one ACP-backed conversation.
#[derive(Debug, Default)]
struct ConversationState {
    /// The engine's own session id, once `session/new` has answered.
    engine_session: Option<String>,
    /// Absolute working directory the session was created in.
    cwd: String,
    /// Model override carried into the next `session/new` for this
    /// conversation. ACP sets the model at session creation, so a mid-session
    /// change is recorded here and applied when the session is next created.
    model: Option<String>,
    /// Permission mode, same lifecycle as `model`.
    permission_mode: Option<String>,
    /// The MCP posture this conversation's engine session was created with.
    ///
    /// Deliberately NOT the same lifecycle as `model` and `permission_mode`.
    /// Those are user preferences that may change mid-conversation and get
    /// re-applied at the next `session/new`; this is a frozen trust decision.
    /// It is written once, at session start, and read back on `session/load`
    /// so a resume replays exactly the fleet the user consented to — a
    /// Settings edit made while the conversation is live must not be able to
    /// broaden it. There is no setter for this by design.
    mcp: super::AcpMcpPosture,
    /// True for exactly as long as a `session/load` is in flight for this
    /// conversation — the window in which every `session/update` the engine
    /// sends is REPLAYED HISTORY, not something happening now.
    ///
    /// See [`translate_update`] for why that window translates to nothing.
    replaying: bool,
    /// Whether a thinking run is currently open (so `thinking-stop` is emitted
    /// exactly once, when something other than a thought arrives).
    thinking: bool,
    tools: HashMap<String, ToolMeta>,
}

#[derive(Default)]
struct Inner {
    /// PacketBench conversation id → state (including the engine's session id).
    conversations: HashMap<String, ConversationState>,
    /// Engine session id → PacketBench conversation id. Every `api-agent:*`
    /// event is keyed on the PacketBench id, so this is the lookup the sink
    /// makes on every single `session/update`.
    by_engine_session: HashMap<String, String>,
    /// Emitted permission id → the record needed to answer it.
    permissions: HashMap<String, PendingPermission>,
}

/// Conversation-level bookkeeping for the ACP transport. Guarded by a
/// `std::sync::Mutex` on purpose: [`AcpEvents`](super::AcpEvents) is a
/// synchronous trait called from the bridge's reader task, so nothing may be
/// awaited while the map is held — and nothing here ever does I/O.
#[derive(Default)]
pub struct AcpSessions {
    inner: Mutex<Inner>,
}

impl AcpSessions {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means some other thread panicked mid-update;
        // the map is still structurally sound and losing every ACP session to
        // it would be a far worse failure than continuing.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Registers a freshly created engine session against its PacketBench
    /// conversation id, replacing any previous binding for that conversation.
    pub fn register(&self, conversation_id: &str, engine_session_id: &str, cwd: &str) {
        let mut inner = self.lock();
        if let Some(previous) = inner
            .conversations
            .get(conversation_id)
            .and_then(|c| c.engine_session.clone())
        {
            inner.by_engine_session.remove(&previous);
        }
        let entry = inner
            .conversations
            .entry(conversation_id.to_string())
            .or_default();
        entry.engine_session = Some(engine_session_id.to_string());
        entry.cwd = cwd.to_string();
        inner
            .by_engine_session
            .insert(engine_session_id.to_string(), conversation_id.to_string());
    }

    /// Records the model / permission-mode a conversation should be created
    /// with, before its engine session exists.
    pub fn set_pending_config(
        &self,
        conversation_id: &str,
        cwd: &str,
        model: Option<String>,
        permission_mode: Option<String>,
    ) {
        let mut inner = self.lock();
        let entry = inner
            .conversations
            .entry(conversation_id.to_string())
            .or_default();
        entry.cwd = cwd.to_string();
        entry.model = model;
        entry.permission_mode = permission_mode;
    }

    /// Records the MCP posture an engine session was created with, freezing it
    /// for the conversation's life. Called exactly once, from the session-start
    /// path, immediately after `session/new` answers.
    pub fn freeze_mcp_posture(&self, conversation_id: &str, posture: super::AcpMcpPosture) {
        let mut inner = self.lock();
        let entry = inner
            .conversations
            .entry(conversation_id.to_string())
            .or_default();
        entry.mcp = posture;
    }

    /// Opens or closes the `session/load` replay window for a conversation.
    ///
    /// Must bracket the `session/load` request itself — the engine streams the
    /// stored transcript as `session/update` notifications BEFORE the request
    /// resolves, so the flag has to be up before the call and down after it,
    /// on the error path as much as the success one. Returns nothing and
    /// tolerates an unknown conversation: a replay window on a conversation
    /// that no longer exists is already a no-op.
    pub fn set_replaying(&self, conversation_id: &str, replaying: bool) {
        let mut inner = self.lock();
        if let Some(entry) = inner.conversations.get_mut(conversation_id) {
            entry.replaying = replaying;
        }
    }

    /// The frozen MCP posture for a conversation.
    ///
    /// An unknown conversation yields [`super::AcpMcpPosture::None`], not a
    /// re-derived decision: if we cannot show what was consented to, the
    /// answer is "no MCP servers", never a guess that spawns subprocesses.
    pub fn mcp_posture(&self, conversation_id: &str) -> super::AcpMcpPosture {
        self.lock()
            .conversations
            .get(conversation_id)
            .map(|c| c.mcp.clone())
            .unwrap_or_default()
    }

    pub fn set_model(&self, conversation_id: &str, model: String) {
        let mut inner = self.lock();
        if let Some(entry) = inner.conversations.get_mut(conversation_id) {
            entry.model = Some(model);
        }
    }

    pub fn set_permission_mode(&self, conversation_id: &str, mode: String) {
        let mut inner = self.lock();
        if let Some(entry) = inner.conversations.get_mut(conversation_id) {
            entry.permission_mode = Some(mode);
        }
    }

    /// `(cwd, model, permission_mode)` for a conversation, if known.
    pub fn pending_config(
        &self,
        conversation_id: &str,
    ) -> Option<(String, Option<String>, Option<String>)> {
        let inner = self.lock();
        inner
            .conversations
            .get(conversation_id)
            .map(|c| (c.cwd.clone(), c.model.clone(), c.permission_mode.clone()))
    }

    /// The engine session id for a PacketBench conversation id.
    pub fn engine_id(&self, conversation_id: &str) -> Option<String> {
        self.lock()
            .conversations
            .get(conversation_id)
            .and_then(|c| c.engine_session.clone())
    }

    /// The engine session id for a PacketBench conversation, or the argument
    /// unchanged when it is not one. Lets the read-only `acp_*` query commands
    /// accept either a live conversation id or a raw engine session id (as
    /// returned by `acp_list_sessions`) without a second command surface.
    pub fn engine_id_or_raw(&self, id: &str) -> String {
        self.engine_id(id).unwrap_or_else(|| id.to_string())
    }

    /// The PacketBench conversation id for an engine session id.
    pub fn conversation_id(&self, engine_session_id: &str) -> Option<String> {
        self.lock()
            .by_engine_session
            .get(engine_session_id)
            .cloned()
    }

    /// Whether the ACP transport owns this conversation. This is the ACP
    /// equivalent of `SidecarManager::owns_session` and the check every
    /// post-start `api_agent` command routes on.
    pub fn owns(&self, conversation_id: &str) -> bool {
        self.lock().conversations.contains_key(conversation_id)
    }

    /// Drops a conversation and everything hanging off it, returning the
    /// engine session id so the caller can `session/close` it.
    pub fn forget(&self, conversation_id: &str) -> Option<String> {
        let mut inner = self.lock();
        let engine = inner
            .conversations
            .remove(conversation_id)
            .and_then(|c| c.engine_session);
        if let Some(id) = &engine {
            inner.by_engine_session.remove(id);
        }
        inner
            .permissions
            .retain(|_, p| p.conversation_id != conversation_id);
        engine
    }

    /// Drops every conversation. Called when the engine stops: its session ids
    /// do not survive a restart, so keeping the map would route later prompts
    /// at sessions that no longer exist.
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.conversations.clear();
        inner.by_engine_session.clear();
        inner.permissions.clear();
    }

    /// Answers-pending permission record, removed from the map.
    pub fn take_permission(&self, id: &str) -> Option<PendingPermission> {
        self.lock().permissions.remove(id)
    }

    /// Removes and returns every unanswered permission for one conversation.
    pub fn drain_permissions(&self, conversation_id: &str) -> Vec<PendingPermission> {
        let mut inner = self.lock();
        let doomed: Vec<String> = inner
            .permissions
            .iter()
            .filter(|(_, p)| p.conversation_id == conversation_id)
            .map(|(k, _)| k.clone())
            .collect();
        doomed
            .into_iter()
            .filter_map(|k| inner.permissions.remove(&k))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/// One `api-agent:*` event to emit: a fully-formed event name and its payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Emission {
    pub event: String,
    pub payload: Value,
}

impl Emission {
    fn new(event: String, payload: Value) -> Self {
        Self { event, payload }
    }
}

fn to_value<T: serde::Serialize>(payload: T) -> Value {
    serde_json::to_value(payload).unwrap_or(Value::Null)
}

/// Text carried by an ACP `content` block, which is either `{type,text}` or a
/// wrapper with the block nested under `content`.
fn content_text(block: &Value) -> Option<String> {
    if let Some(text) = block.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    block
        .get("content")
        .and_then(|inner| inner.get("text"))
        .and_then(Value::as_str)
        .map(String::from)
}

/// Flattens a `tool_call_update.content` array into the single string the
/// `tool-result` payload carries. Non-text blocks (diffs, terminal handles)
/// are serialized as JSON rather than dropped — the frontend renders unknown
/// tool output verbatim, and losing it silently is worse than showing it raw.
fn join_tool_content(content: Option<&Value>) -> String {
    let Some(items) = content.and_then(Value::as_array) else {
        return content
            .and_then(content_text)
            .unwrap_or_default();
    };
    items
        .iter()
        .map(|item| content_text(item).unwrap_or_else(|| item.to_string()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A tool call's display name. ACP puts the human label in `title`; `kind`
/// ("read", "edit", "execute", …) is the fallback, and the id the last resort
/// so a nameless call still renders as something.
fn tool_name(update: &Value, tool_id: &str) -> String {
    for key in ["title", "kind"] {
        if let Some(name) = update
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return name.to_string();
        }
    }
    tool_id.to_string()
}

fn tool_input(update: &Value) -> String {
    match update.get("rawInput") {
        Some(Value::Null) | None => "{}".to_string(),
        Some(value) => value.to_string(),
    }
}

/// The `thinking-stop` emission, if a thinking run is open. Called before any
/// non-thought emission and when a turn ends, so the frontend's thinking
/// indicator can never be left spinning.
fn close_thinking(state: &mut ConversationState, conversation_id: &str) -> Option<Emission> {
    if !state.thinking {
        return None;
    }
    state.thinking = false;
    Some(Emission::new(
        api::thinking_stop_event(conversation_id),
        Value::Null,
    ))
}

/// Translates ONE ACP `session/update` payload into `api-agent:*` emissions.
///
/// | ACP `sessionUpdate`                    | api-agent event |
/// |----------------------------------------|-----------------|
/// | `agent_message_chunk`                  | `chunk` (raw string payload) |
/// | `agent_thought_chunk`                  | `thinking` |
/// | `tool_call`                            | `tool-start` |
/// | `tool_call_update` (completed/failed)  | `tool-result` |
/// | `tool_call_update` (pending/in_progress)| — (nothing) |
/// | `plan`                                 | `plan-block` |
/// | `user_message_chunk`                   | — (load replay; PacketBench owns the transcript) |
/// | anything else                          | — (ignored) |
///
/// # The `session/load` replay window emits NOTHING
///
/// While `state.replaying` is set (see [`AcpSessions::set_replaying`]) this
/// function returns no emissions at all, whatever the update says. That is a
/// deliberate honesty decision, not an optimisation.
///
/// ACP replays a loaded session's stored transcript as `session/update`
/// notifications, and the replay includes `user_message_chunk` updates — but
/// the api-agent event contract has no user-turn event, so the ONLY thing the
/// translation layer could do with the user's own prompts is drop them (which
/// is exactly what the live path must keep doing: during a live turn the
/// engine echoes the prompt PacketBench just sent, and emitting it would
/// duplicate every message).
///
/// Admitting the rest of the replay anyway would produce a transcript with
/// every assistant turn and every tool call present and every user turn
/// missing — and, because `chunk` payloads stream into whatever assistant
/// message is currently open, the whole of that history welded into one
/// bubble. An adopted conversation has no local record to interleave, so
/// PacketBench cannot repair it either. A half-transcript that LOOKS complete is
/// a worse answer than no transcript plus a plain statement that the history
/// lives in the engine, which is what the adopting conversation carries
/// instead (`agentTaskStore.adoptEngineSession`).
///
/// The engine still holds the full history as the model's context; only the
/// rendering is declined.
fn translate_update(
    state: &mut ConversationState,
    conversation_id: &str,
    params: &Value,
) -> Vec<Emission> {
    let Some(update) = params.get("update") else {
        return Vec::new();
    };
    if state.replaying {
        return Vec::new();
    }
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // A thought run ends the moment anything else shows up.
    let mut out = Vec::new();
    if kind != "agent_thought_chunk" {
        out.extend(close_thinking(state, conversation_id));
    }

    match kind {
        "agent_message_chunk" => {
            let text = update.get("content").and_then(content_text).unwrap_or_default();
            // The chunk payload is a RAW STRING, not a struct — matching
            // `api_agent.rs` and the sidecar exactly.
            out.push(Emission::new(
                api::chunk_event(conversation_id),
                Value::String(text),
            ));
        }
        "agent_thought_chunk" => {
            state.thinking = true;
            let text = update.get("content").and_then(content_text).unwrap_or_default();
            out.push(Emission::new(
                api::thinking_event(conversation_id),
                to_value(api::ThinkingPayload { text }),
            ));
        }
        "tool_call" => {
            let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                return out;
            };
            let name = tool_name(update, id);
            let input = tool_input(update);
            state.tools.insert(
                id.to_string(),
                ToolMeta {
                    name: name.clone(),
                    input: input.clone(),
                },
            );
            out.push(Emission::new(
                api::tool_start_event(conversation_id),
                to_value(api::ToolStartPayload {
                    id: id.to_string(),
                    name,
                    input: Some(input),
                }),
            ));
        }
        "tool_call_update" => {
            let Some(id) = update.get("toolCallId").and_then(Value::as_str) else {
                return out;
            };
            let status = update.get("status").and_then(Value::as_str).unwrap_or("");
            // in_progress / pending are progress pings, not results: emitting
            // a tool-result for them would close the card while the tool is
            // still running.
            let is_error = match status {
                "completed" => false,
                "failed" => true,
                _ => return out,
            };
            let meta = state.tools.remove(id).unwrap_or_default();
            let name = if meta.name.is_empty() {
                tool_name(update, id)
            } else {
                meta.name
            };
            let input = if meta.input.is_empty() {
                tool_input(update)
            } else {
                meta.input
            };
            out.push(Emission::new(
                api::tool_result_event(conversation_id),
                to_value(api::ToolResultPayload {
                    id: id.to_string(),
                    name,
                    content: join_tool_content(update.get("content")),
                    is_error,
                    input,
                }),
            ));
        }
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let items = entries
                .iter()
                .map(|entry| api::PlanItemPayload {
                    id: entry
                        .get("id")
                        .or_else(|| entry.get("entryId"))
                        .and_then(Value::as_str)
                        .map(String::from),
                    content: entry
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    status: entry
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending")
                        .to_string(),
                    active_form: entry
                        .get("activeForm")
                        .and_then(Value::as_str)
                        .map(String::from),
                })
                .collect();
            out.push(Emission::new(
                api::plan_block_event(conversation_id),
                to_value(api::PlanBlockPayload { items }),
            ));
        }
        // Load-replay only. PacketBench rebuilds transcripts from its own
        // conversation store, so replaying the user's own turns back at it
        // would duplicate every message.
        "user_message_chunk" => {}
        _ => {}
    }
    out
}

/// Translates an ACP permission request into a `permission-request` emission
/// plus the record needed to answer it later.
///
/// The engine's JSON-RPC id may be a STRING ("packetcode-permission-1"), while
/// the api-agent payload's `id` is typed as a String. The wire id is therefore
/// stringified for the payload (a JSON string yields its contents, not its
/// quoted form) and the raw `Value` is kept alongside so the reply frame
/// echoes exactly what arrived.
fn translate_permission_request(
    conversation_id: &str,
    payload: &Value,
) -> Option<(Emission, PendingPermission)> {
    let raw_id = payload.get("requestId")?.clone();
    let id = match &raw_id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let tool_call = payload.get("toolCall");
    let tool_id = tool_call
        .and_then(|t| t.get("toolCallId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = tool_call
        .map(|t| tool_name(t, tool_id))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "permission".to_string());
    let arguments = match tool_call.and_then(|t| t.get("rawInput")) {
        Some(Value::Null) | None => tool_call.map(Value::to_string).unwrap_or_else(|| "{}".into()),
        Some(value) => value.to_string(),
    };
    let options = payload
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|option| {
                    Some(PermissionOption {
                        option_id: option.get("optionId").and_then(Value::as_str)?.to_string(),
                        kind: option
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let emission = Emission::new(
        api::permission_request_event(conversation_id),
        to_value(api::PermissionRequestPayload {
            id: id.clone(),
            name,
            arguments,
            batch_id: None,
            batch_size: None,
        }),
    );
    Some((
        emission,
        PendingPermission {
            id,
            raw_id,
            conversation_id: conversation_id.to_string(),
            options,
        },
    ))
}

/// The terminal `done` payload for a finished ACP turn.
///
/// ACP reports usage as the engine's `_packetcode.usage` block
/// (`contextTokens` / `totalInput` / `totalOutput` / `costUsd`). Only the two
/// token totals have api-agent equivalents; the cache counters are Anthropic
/// concepts the engine does not report, so they are zero rather than invented.
pub fn done_payload(outcome: Option<&super::PromptOutcome>) -> Value {
    let usage = outcome.and_then(|o| o.usage.as_ref());
    to_value(api::DonePayload {
        input_tokens: usage.map(|u| u.total_input).unwrap_or(0),
        output_tokens: usage.map(|u| u.total_output).unwrap_or(0),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cancelled: outcome
            .map(|o| o.stop_reason == "cancelled")
            .unwrap_or(false),
        // ACP resumption goes through `session/load` against the engine's own
        // session id, which PacketBench already holds in `AcpSessions` — there
        // is no opaque token for the frontend to carry.
        resume_token: None,
    })
}

pub fn error_payload(message: impl Into<String>) -> Value {
    to_value(api::ErrorPayload {
        message: message.into(),
    })
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/// [`AcpEvents`](super::AcpEvents) implementation that emits PacketBench's
/// `api-agent:*` contract.
pub struct ApiAgentSink {
    app: AppHandle,
    sessions: Arc<AcpSessions>,
}

impl ApiAgentSink {
    pub fn new(app: AppHandle, sessions: Arc<AcpSessions>) -> Self {
        Self { app, sessions }
    }

    fn emit_all(&self, emissions: Vec<Emission>) {
        for emission in emissions {
            let _ = self.app.emit(&emission.event, emission.payload);
        }
    }
}

impl super::AcpEvents for ApiAgentSink {
    fn on_update(&self, params: Value) {
        let Some(engine_session) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let mut inner = self.sessions.lock();
        // Every api-agent event is keyed on PacketBench's conversation id. An
        // update for a session we never registered has nowhere to go — drop it
        // rather than emit an event no listener is subscribed to.
        let Some(conversation_id) = inner.by_engine_session.get(engine_session).cloned() else {
            return;
        };
        let Some(state) = inner.conversations.get_mut(&conversation_id) else {
            return;
        };
        let emissions = translate_update(state, &conversation_id, &params);
        drop(inner);
        self.emit_all(emissions);
    }

    fn on_permission_request(&self, payload: Value) {
        let Some(engine_session) = payload.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let mut inner = self.sessions.lock();
        let Some(conversation_id) = inner.by_engine_session.get(engine_session).cloned() else {
            return;
        };
        // A permission prompt ends any open thinking run: the user is about to
        // be asked a question, not watched thinking.
        let mut emissions = Vec::new();
        if let Some(state) = inner.conversations.get_mut(&conversation_id) {
            emissions.extend(close_thinking(state, &conversation_id));
        }
        let Some((emission, pending)) = translate_permission_request(&conversation_id, &payload)
        else {
            drop(inner);
            self.emit_all(emissions);
            return;
        };
        inner.permissions.insert(pending.id.clone(), pending);
        drop(inner);
        emissions.push(emission);
        self.emit_all(emissions);
    }
}

/// Emits a fully-formed `api-agent:*` event for a conversation. Used by the
/// routing layer for the events that are not born of a `session/update` —
/// `done`, `error`, and the thinking-stop that closes a turn.
pub fn emit(app: &AppHandle, event: String, payload: Value) {
    let _ = app.emit(&event, payload);
}

/// Closes any open thinking run for a conversation and emits `thinking-stop`.
/// Called when a turn ends by any route, so an interrupted thought never
/// leaves the indicator spinning.
pub fn finish_thinking(app: &AppHandle, sessions: &AcpSessions, conversation_id: &str) {
    let emission = {
        let mut inner = sessions.lock();
        inner
            .conversations
            .get_mut(conversation_id)
            .and_then(|state| close_thinking(state, conversation_id))
    };
    if let Some(emission) = emission {
        emit(app, emission.event, emission.payload);
    }
}

/// Fails every tool call still marked in flight for a conversation. A turn
/// that ends mid-tool (cancel, engine error) otherwise leaves the frontend
/// with a tool card that never resolves.
pub fn fail_open_tools(
    app: &AppHandle,
    sessions: &AcpSessions,
    conversation_id: &str,
    reason: &str,
) {
    let open: Vec<(String, ToolMeta)> = {
        let mut inner = sessions.lock();
        match inner.conversations.get_mut(conversation_id) {
            Some(state) => state.tools.drain().collect(),
            None => Vec::new(),
        }
    };
    for (id, meta) in open {
        emit(
            app,
            api::tool_result_event(conversation_id),
            to_value(api::ToolResultPayload {
                id,
                name: meta.name,
                content: reason.to_string(),
                is_error: true,
                input: meta.input,
            }),
        );
    }
}

/// Convenience for the routing layer: `api-agent:error:{conversationId}`.
pub fn emit_error(app: &AppHandle, conversation_id: &str, message: impl Into<String>) {
    emit(
        app,
        api::error_event(conversation_id),
        error_payload(message),
    );
}

/// Convenience for the routing layer: `api-agent:done:{conversationId}`.
pub fn emit_done(app: &AppHandle, conversation_id: &str, outcome: Option<&super::PromptOutcome>) {
    emit(
        app,
        api::done_event(conversation_id),
        done_payload(outcome),
    );
}

/// The `_packetcode.usage` block as a live `turn-summary`. ACP totals are
/// SESSION-cumulative, so this is only useful to a consumer that treats it as
/// a snapshot; it is deliberately not emitted on the ordinary turn path.
#[allow(dead_code)]
pub fn turn_summary_payload(usage: &super::SessionUsage) -> Value {
    to_value(api::TurnSummaryPayload {
        input_tokens: usage.total_input,
        output_tokens: usage.total_output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_tokens: None,
        address: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn update(body: Value) -> Value {
        json!({ "sessionId": "sess-1", "update": body })
    }

    fn translate(state: &mut ConversationState, body: Value) -> Vec<Emission> {
        translate_update(state, "conv-1", &update(body))
    }

    #[test]
    fn agent_message_chunk_payload_is_a_raw_string() {
        let mut state = ConversationState::default();
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Hello, " }
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "api-agent:chunk:conv-1");
        // Not a struct, not an object with a `text` field — the bare string,
        // exactly as `api_agent.rs` and the sidecar emit it.
        assert_eq!(out[0].payload, json!("Hello, "));
    }

    #[test]
    fn thought_chunks_open_a_run_that_the_next_update_closes() {
        let mut state = ConversationState::default();
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "Thinking about the task." }
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "api-agent:thinking:conv-1");
        assert_eq!(out[0].payload, json!({ "text": "Thinking about the task." }));
        assert!(state.thinking);

        // A second thought does NOT close the run.
        let out = translate(
            &mut state,
            json!({ "sessionUpdate": "agent_thought_chunk", "content": { "text": "more" } }),
        );
        assert_eq!(out.len(), 1);

        // Anything else does, exactly once, with a unit payload.
        let out = translate(
            &mut state,
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "hi" } }),
        );
        assert_eq!(out[0].event, "api-agent:thinking-stop:conv-1");
        assert_eq!(out[0].payload, Value::Null);
        assert_eq!(out[1].event, "api-agent:chunk:conv-1");
        assert!(!state.thinking);

        let out = translate(
            &mut state,
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "there" } }),
        );
        assert_eq!(out.len(), 1, "thinking-stop must not repeat");
    }

    #[test]
    fn tool_call_then_completed_update_yields_a_successful_tool_result() {
        let mut state = ConversationState::default();
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "Demo tool",
                "kind": "execute",
                "status": "pending",
                "rawInput": { "cmd": "ls" }
            }),
        );
        assert_eq!(out[0].event, "api-agent:tool-start:conv-1");
        assert_eq!(out[0].payload["id"], "call-1");
        assert_eq!(out[0].payload["name"], "Demo tool");
        assert_eq!(out[0].payload["input"], json!(r#"{"cmd":"ls"}"#));

        // in_progress is a progress ping, never a result.
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "in_progress"
            }),
        );
        assert!(out.is_empty(), "in-progress must not emit tool-result");

        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "content": [
                    { "type": "content", "content": { "type": "text", "text": "demo tool output" } }
                ]
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "api-agent:tool-result:conv-1");
        assert_eq!(
            out[0].payload,
            json!({
                "id": "call-1",
                // Name and input come from the remembered tool_call: the ACP
                // update itself carries neither.
                "name": "Demo tool",
                "content": "demo tool output",
                "is_error": false,
                "input": r#"{"cmd":"ls"}"#
            })
        );
    }

    #[test]
    fn failed_tool_call_update_sets_is_error() {
        let mut state = ConversationState::default();
        translate(
            &mut state,
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "Demo tool"
            }),
        );
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "failed"
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].payload["is_error"], json!(true));
        assert_eq!(out[0].payload["name"], "Demo tool");
    }

    #[test]
    fn plan_maps_to_plan_block_preserving_active_form() {
        let mut state = ConversationState::default();
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "plan",
                "entries": [
                    {
                        "id": "todo-1",
                        "content": "Inspect the request",
                        "priority": "high",
                        "status": "completed"
                    },
                    {
                        "content": "Run checks",
                        "status": "in_progress",
                        "activeForm": "Running checks"
                    }
                ]
            }),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "api-agent:plan-block:conv-1");
        let items = out[0].payload["items"].as_array().expect("items array");
        assert_eq!(items[0]["id"], "todo-1");
        assert_eq!(items[0]["content"], "Inspect the request");
        assert_eq!(items[0]["status"], "completed");
        // Absent optionals are omitted, not nulled.
        assert!(items[0].get("activeForm").is_none());
        assert!(items[1].get("id").is_none());
        // The serde rename is what the frontend reads.
        assert_eq!(items[1]["activeForm"], "Running checks");
        assert!(items[1].get("active_form").is_none());
    }

    #[test]
    fn user_message_chunks_are_dropped() {
        let mut state = ConversationState::default();
        let out = translate(
            &mut state,
            json!({
                "sessionUpdate": "user_message_chunk",
                "content": { "type": "text", "text": "replayed prompt" }
            }),
        );
        assert!(out.is_empty(), "PacketBench owns the transcript, not the engine");
    }

    /// The `session/load` replay window renders NOTHING.
    ///
    /// Not an optimisation: ACP's replay carries the assistant's turns and the
    /// tool calls but PacketBench has no event for the user's own prompts, so
    /// admitting the rest would paint a transcript with every question missing
    /// and every answer welded into one bubble. The engine keeps the history
    /// as the model's context either way; only the rendering is declined, and
    /// the adopting conversation says so in words.
    #[test]
    fn the_load_replay_window_emits_nothing() {
        let mut state = ConversationState { replaying: true, ..Default::default() };
        for body in [
            json!({ "sessionUpdate": "user_message_chunk", "content": { "text": "fix the bug" } }),
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "Sure —" } }),
            json!({ "sessionUpdate": "agent_thought_chunk", "content": { "text": "hmm" } }),
            json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "t-1",
                "title": "Read",
                "rawInput": { "path": "a.rs" }
            }),
            json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t-1",
                "status": "completed",
                "content": [{ "type": "text", "text": "fn main() {}" }]
            }),
            json!({ "sessionUpdate": "plan", "entries": [{ "content": "step", "status": "pending" }] }),
        ] {
            assert!(
                translate(&mut state, body.clone()).is_empty(),
                "replayed {body} must not reach the transcript",
            );
        }
        // Nothing was recorded either: a replayed thought must not leave the
        // thinking indicator armed, and a replayed tool must not leave a card
        // waiting for a result that will never be emitted.
        assert!(!state.thinking);
        assert!(state.tools.is_empty());
    }

    /// Closing the window restores the live translation exactly — the gate is
    /// scoped to the load, not a permanent mute on the conversation.
    #[test]
    fn closing_the_replay_window_restores_live_translation() {
        let sessions = AcpSessions::default();
        sessions.register("conv-1", "sess-1", "/w");

        sessions.set_replaying("conv-1", true);
        {
            let mut inner = sessions.lock();
            let state = inner.conversations.get_mut("conv-1").expect("registered");
            assert!(translate_update(
                state,
                "conv-1",
                &update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "old" } })),
            )
            .is_empty());
        }

        sessions.set_replaying("conv-1", false);
        let mut inner = sessions.lock();
        let state = inner.conversations.get_mut("conv-1").expect("registered");
        let out = translate_update(
            state,
            "conv-1",
            &update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "text": "new" } })),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].event, "api-agent:chunk:conv-1");
        assert_eq!(out[0].payload, json!("new"));
    }

    /// `set_replaying` on a conversation that was never registered is a no-op,
    /// not a panic and not a phantom entry — a replay window belongs to a
    /// conversation, and one that has gone away has nothing to mute.
    #[test]
    fn set_replaying_tolerates_an_unknown_conversation() {
        let sessions = AcpSessions::default();
        sessions.set_replaying("nobody", true);
        assert!(!sessions.owns("nobody"));
    }

    /// The real engine uses STRING JSON-RPC ids. The payload id must be the
    /// plain string (not its quoted JSON form), and the raw Value must survive
    /// so `permission_reply` echoes the exact wire id back.
    #[test]
    fn string_permission_id_round_trips_exactly() {
        let payload = json!({
            "sessionId": "sess-1",
            "requestId": "packetcode-permission-1",
            "toolCall": { "toolCallId": "call-1", "title": "Demo tool", "rawInput": { "cmd": "ls" } },
            "options": [
                { "optionId": "allow_once", "name": "Allow", "kind": "allow_once" },
                { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" }
            ]
        });
        let (emission, pending) =
            translate_permission_request("conv-1", &payload).expect("translated");

        assert_eq!(emission.event, "api-agent:permission-request:conv-1");
        assert_eq!(emission.payload["id"], "packetcode-permission-1");
        assert_eq!(emission.payload["name"], "Demo tool");
        assert_eq!(emission.payload["arguments"], json!(r#"{"cmd":"ls"}"#));

        // Stored under the same id the frontend was given...
        assert_eq!(pending.id, "packetcode-permission-1");
        // ...and the raw id is the JSON string, so the reply frame's `id`
        // field is byte-identical to what the engine sent.
        assert_eq!(pending.raw_id, json!("packetcode-permission-1"));
        assert_eq!(pending.raw_id.to_string(), "\"packetcode-permission-1\"");

        // The AcpSessions round trip the routing layer actually performs.
        let sessions = AcpSessions::default();
        sessions.register("conv-1", "sess-1", "/w");
        sessions.lock().permissions.insert(pending.id.clone(), pending);
        let taken = sessions
            .take_permission("packetcode-permission-1")
            .expect("recorded permission is answerable by its emitted id");
        assert_eq!(taken.raw_id, json!("packetcode-permission-1"));
        assert_eq!(taken.option_for("allow_once"), Some("allow_once"));
        assert_eq!(taken.option_for("deny"), Some("reject_once"));
        // "Always" degrades to the one-shot option the engine actually offers.
        assert_eq!(taken.option_for("allow_always"), Some("allow_once"));
        assert!(sessions.take_permission("packetcode-permission-1").is_none());
    }

    /// A numeric id (some other ACP agent) must survive too — stringified for
    /// the payload, kept as a number for the reply.
    #[test]
    fn numeric_permission_id_is_stringified_but_replied_as_a_number() {
        let payload = json!({ "sessionId": "sess-1", "requestId": 42, "options": [] });
        let (emission, pending) =
            translate_permission_request("conv-1", &payload).expect("translated");
        assert_eq!(emission.payload["id"], "42");
        assert_eq!(pending.raw_id, json!(42));
    }

    #[test]
    fn session_map_is_bidirectional_and_forgettable() {
        let sessions = AcpSessions::default();
        assert!(!sessions.owns("conv-1"));
        sessions.register("conv-1", "sess-9", "/w");
        assert!(sessions.owns("conv-1"));
        assert_eq!(sessions.engine_id("conv-1").as_deref(), Some("sess-9"));
        assert_eq!(
            sessions.conversation_id("sess-9").as_deref(),
            Some("conv-1")
        );
        // Unmapped ids pass through, so the read-only query commands accept a
        // raw engine session id from acp_list_sessions.
        assert_eq!(sessions.engine_id_or_raw("conv-1"), "sess-9");
        assert_eq!(sessions.engine_id_or_raw("sess-from-disk"), "sess-from-disk");

        // Re-registering drops the stale reverse entry rather than leaving a
        // second engine id pointing at the same conversation.
        sessions.register("conv-1", "sess-10", "/w");
        assert!(sessions.conversation_id("sess-9").is_none());

        assert_eq!(sessions.forget("conv-1").as_deref(), Some("sess-10"));
        assert!(!sessions.owns("conv-1"));
        assert!(sessions.conversation_id("sess-10").is_none());
    }

    #[test]
    fn done_payload_maps_engine_usage_and_the_cancelled_flag() {
        let outcome = super::super::PromptOutcome {
            stop_reason: "end_turn".to_string(),
            usage: Some(super::super::SessionUsage {
                context_tokens: 41234,
                total_input: 82000,
                total_output: 12000,
                cost_usd: 1.84,
            }),
        };
        assert_eq!(
            done_payload(Some(&outcome)),
            json!({
                "input_tokens": 82000,
                "output_tokens": 12000,
                // The engine reports no cache accounting; zero, never invented.
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "cancelled": false
            })
        );

        let cancelled = super::super::PromptOutcome {
            stop_reason: "cancelled".to_string(),
            usage: None,
        };
        let payload = done_payload(Some(&cancelled));
        assert_eq!(payload["cancelled"], json!(true));
        assert_eq!(payload["input_tokens"], json!(0));
    }
}
