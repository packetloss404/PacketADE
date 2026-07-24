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
pub(super) fn edit_baseline_event(session_id: &str) -> String {
    format!("api-agent:edit-baseline:{}", session_id)
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
/// S8-Phase-B: reports which MCP servers the remote sidecar sourced from its
/// OWN filesystem for this session (plus read/parse errors).
pub(super) fn mcp_sources_event(session_id: &str) -> String {
    format!("api-agent:mcp-sources:{}", session_id)
}

// ---------------------------------------------------------------------------
// Event payload shapes — must match `api_agent.rs` exactly so the frontend
// listeners in `agentTaskStore.ts` can't tell which backend emitted the event.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub(super) struct ToolStartPayload {
    pub id: String,
    pub name: String,
    /// P1-7: raw tool-input JSON, forwarded from the sidecar's `tool_use`
    /// block so the frontend transcript layer can parse edit tool calls
    /// (Write/Edit/apply_patch) — sidecar `tool_result` events don't echo
    /// the input back. Omitted when the sidecar didn't send one (the
    /// in-process backend delivers input on the tool_result instead).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
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

/// P1-7: non-blocking pre-edit baseline for auto-applied writes
/// (approve-writes off). The frontend records it so review surfaces diff
/// applied edits against the true "before" instead of live disk.
#[derive(Clone, Serialize)]
pub(super) struct EditBaselinePayload {
    pub id: String,
    pub path: String,
    /// Pre-edit file content (None when the file did not exist).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[derive(Clone, Serialize)]
pub(super) struct DonePayload {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cancelled: bool,
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
    #[serde(rename = "activeForm", skip_serializing_if = "Option::is_none")]
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

/// S8-Phase-B (Slice B): one MCP server the remote sidecar sourced from its
/// own filesystem. Carries name/transport/scope ONLY — never command, env,
/// headers, or any secret.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpSourceInfo {
    pub name: String,
    /// "stdio" | "http" | "sse"
    pub transport: String,
    /// "global" | "project"
    pub scope: String,
}

/// S8-Phase-B (Slice B): a read/parse error the sidecar hit while sourcing
/// remote MCP config. Carries the failing scope/path/message ONLY.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpReadError {
    /// "global" | "project"
    pub scope: String,
    pub path: String,
    pub message: String,
}

/// S8-Phase-B (Slice B): structured summary of the remote-sourced MCP config
/// for a session, translated from the sidecar `mcp_sources` event and
/// re-emitted as `api-agent:mcp-sources:{sessionId}`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpSourcesPayload {
    pub sources: Vec<McpSourceInfo>,
    pub read_errors: Vec<McpReadError>,
}

#[cfg(test)]
mod tests {
    use super::PlanItemPayload;

    #[test]
    fn plan_item_serializes_active_form_in_frontend_shape() {
        let value = serde_json::to_value(PlanItemPayload {
            id: Some("todo-1".to_string()),
            content: "Run checks".to_string(),
            status: "in_progress".to_string(),
            active_form: Some("Running checks".to_string()),
        })
        .expect("serialize plan item");

        assert_eq!(value["activeForm"], "Running checks");
        assert!(value.get("active_form").is_none());
    }
}
