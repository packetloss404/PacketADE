//! Event name helpers and payload shapes for `api-agent:*` Tauri events.
//!
//! Names and shapes must match `api_agent.rs` exactly so the frontend
//! listeners in `agentTaskStore.ts` can't tell which backend emitted the
//! event.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Event name helpers — must match `api_agent.rs` exactly.
// ---------------------------------------------------------------------------

pub(super) fn chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
pub(super) fn tool_start_event(session_id: &str) -> String {
    format!("api-agent:tool-start:{}", session_id)
}
pub(super) fn tool_result_event(session_id: &str) -> String {
    format!("api-agent:tool-result:{}", session_id)
}
pub(super) fn done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
pub(super) fn error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}
pub(super) fn thinking_event(session_id: &str) -> String {
    format!("api-agent:thinking:{}", session_id)
}
pub(super) fn thinking_stop_event(session_id: &str) -> String {
    format!("api-agent:thinking-stop:{}", session_id)
}
pub(super) fn permission_request_event(session_id: &str) -> String {
    format!("api-agent:permission-request:{}", session_id)
}
pub(super) fn pending_edit_event(session_id: &str) -> String {
    format!("api-agent:pending-edit:{}", session_id)
}
pub(super) fn plan_block_event(session_id: &str) -> String {
    format!("api-agent:plan-block:{}", session_id)
}
pub(super) fn tool_output_extended_event(session_id: &str) -> String {
    format!("api-agent:tool-output-extended:{}", session_id)
}
pub(super) fn turn_summary_event(session_id: &str) -> String {
    format!("api-agent:turn-summary:{}", session_id)
}

// ---------------------------------------------------------------------------
// Event payload shapes — must match `api_agent.rs` exactly so the frontend
// listeners in `agentTaskStore.ts` can't tell which backend emitted the event.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub(super) struct ToolStartPayload {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub(super) struct ToolResultPayload {
    pub id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
    pub input: String,
}

#[derive(Clone, Serialize)]
pub(super) struct ThinkingPayload {
    pub text: String,
}

#[derive(Clone, Serialize)]
pub(super) struct PermissionRequestPayload {
    pub id: String,
    pub name: String,
    pub arguments: String,
    /// v3: when the provider knows several permission requests are landing
    /// as a logical batch (e.g. three Bash calls in a row), these tell the
    /// UI to render an "approve all N" rollup with the right denominator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<u64>,
}

#[derive(Clone, Serialize)]
pub(super) struct PendingEditPayload {
    pub id: String,
    pub path: String,
    pub content: String,
    /// Prior file content (None for new files) so the frontend can render
    /// a real before/after diff instead of just the new content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct DonePayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    /// v3: opaque resume token the frontend can persist and re-send via
    /// `start_api_agent_session.resume` to continue this conversation across
    /// app restarts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_token: Option<String>,
}

/// v3: structured plan/todo item parsed by the provider from the
/// Anthropic SDK's TodoWrite tool call (or equivalent).
#[derive(Clone, Serialize)]
pub(super) struct PlanItemPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    /// "pending" | "in_progress" | "completed"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct PlanBlockPayload {
    pub items: Vec<PlanItemPayload>,
}

#[derive(Clone, Serialize)]
pub(super) struct ToolOutputExtendedPayload {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct TurnSummaryPayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    /// Reasoning tokens — Codex 0.125+ exposes this; Anthropic doesn't yet.
    /// Billed at the OUTPUT rate everywhere it appears.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// A3: Codex MultiAgentV2 sub-agent path (`/root/agent_a` etc.). When
    /// present, the frontend attributes these tokens to a per-address
    /// bucket on the conversation instead of the root totals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct ErrorPayload {
    pub message: String,
}
