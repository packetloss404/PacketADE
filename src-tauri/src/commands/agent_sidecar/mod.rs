//! Node sidecar process supervisor.
//!
//! Spawns and maintains a long-lived `node agent-sidecar/dist/index.js` child
//! process, speaks a newline-delimited JSON protocol over stdin/stdout, and
//! translates sidecar events into the `api-agent:*` Tauri events the frontend
//! already listens on (see `api_agent.rs` for the existing shapes that this
//! supervisor must mirror exactly — the frontend cannot tell which backend
//! produced the event).
//!
//! Slice B of the SDK-sidecar plan: plumbing only. Slice C (the routing layer
//! in `api_agent.rs`) calls the `forward_*` methods exposed here; no Tauri
//! commands are registered from this module — except `get_sidecar_status`
//! below.

use std::sync::Arc;
use std::time::Duration;

mod events;
mod handler;
mod protocol;
mod status;
mod supervisor;

#[allow(unused_imports)]
pub use status::{SidecarLifetimeStats, SidecarStatus};
pub use supervisor::SidecarManager;

/// Providers whose sessions are routed through the Node sidecar rather than
/// the in-process Rust runtime. Keep in sync with slice C's dispatch logic.
pub const SIDECAR_PROVIDERS: &[&str] = &["claude-oauth", "openai-codex", "openai-agents", "echo"];

/// Wire protocol version this supervisor was built against. Must match
/// `PROTOCOL_VERSION` in `agent-sidecar/src/protocol.ts`. We log a warning if
/// the sidecar advertises a different value on its `ready` event, but we do
/// not refuse to proceed — this is a soft compatibility signal, not a gate.
///
/// v2 (Tier 3 slice B): added `set_permission_mode`, `set_model`, and `retry`
/// request types on the wire.
///
/// v3 (PacketADE Tier 3 slice A): added typed `attachments` on start/send,
/// `mergedContent` on edit_response, `batchId`/`batchSize` on
/// `permission_request`, `resumeToken` on `done`, and three new events:
/// `plan_block`, `tool_output_extended`, `turn_summary`.
///
/// v4 (F8): added `cancel_pending_tools` request — drains parked
/// permission/edit prompts as denied without killing the session.
///
/// v5 (Flight Planner E1): added `inject_user_turn` request (typed
/// wake-trigger injection — distinct from `send_message` so the planner
/// system prompt can reliably tell wake-triggered re-entry apart from a
/// real user message), plus an optional `mcpKind` field on
/// `start_session` so the sidecar can construct in-process MCP servers
/// (e.g. the Flight Planner tool surface) locally without those live
/// JS instances having to cross the wire.
///
/// v6 (rate-limit signal): added the `rate_limited` event. The Anthropic
/// provider catches `RateLimitError` (HTTP 429) and emits it alongside the
/// regular `error` emit; this supervisor records it to the log (the
/// `error` event already surfaces the failure to the session).
///
/// v7 (planner amputation): removed the in-process planner MCP surface —
/// the `planner_tool` event, the `planner_tool_result` request, and the
/// `mcpKind` field on `start_session`. The Rust planner backend was deleted
/// in C2-S1, so the supervisor no longer emits or accepts planner
/// envelopes. `inject_user_turn` and `rate_limited` survive. Negotiation
/// stays warn-only, so a v6 sidecar paired with a v7 supervisor (or vice
/// versa) still connects.
///
/// v8 (S8-Phase-B): added `sourceMcpFromFs` on `start_session` (remote-owned
/// MCP config sourcing — the sidecar reads its own ~/.claude/settings.json +
/// <project>/.mcp.json and runs ALL servers from there, ignoring the forwarded
/// `mcpServers`) plus the `mcp_sources` event reporting which servers were
/// sourced (name/transport/scope) and any read errors — no commands/secrets.
/// Negotiation stays warn-only.
///
/// v9 (G11): `edit_response` now carries the pending edit's `toolUseId`, so
/// providers resolve one exact approval instead of draining every edit.
pub(super) const EXPECTED_PROTOCOL_VERSION: u32 = 9;

/// Convenience predicate used by slice C to decide whether to call
/// `forward_*` vs. the existing Rust path.
pub fn is_sidecar_provider(provider: &str) -> bool {
    SIDECAR_PROVIDERS.contains(&provider)
}

/// Maximum sidecar restarts allowed within `RESTART_WINDOW`.
pub(super) const MAX_RESTARTS_IN_WINDOW: usize = 3;
pub(super) const RESTART_WINDOW: Duration = Duration::from_secs(60);

/// Tauri event name emitted whenever the sidecar's lifecycle state transitions
/// (ready / restarting / down / not_started). The frontend status-bar chip
/// subscribes to this to update without polling.
pub(super) const SIDECAR_STATUS_EVENT: &str = "sidecar-status:changed";

// ---------------------------------------------------------------------------
// Tauri commands (v2 Tier 2 slice B)
// ---------------------------------------------------------------------------

/// Return the sidecar's current lifecycle status. The frontend status-bar
/// chip polls this on mount, then listens for `sidecar-status:changed` to get
/// live updates without further polling.
///
/// Never fails — the manager is always registered by `.setup()` before any
/// invoke handler can be called. Returns the default ("not_started") status
/// if the manager has not yet observed any lifecycle event.
#[tauri::command]
pub async fn get_sidecar_status(
    state: tauri::State<'_, Arc<SidecarManager>>,
) -> Result<SidecarStatus, String> {
    Ok(state.current_status().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_routes_through_the_sidecar_forward_path() {
        // Codex is a sidecar provider, so start_session for it goes through the
        // `forward_*` path — which is provider-agnostic w.r.t. SSH. This is what
        // makes Codex-over-SSH work via the remote sidecar (no per-provider SSH
        // gate); a regression that dropped codex here would force it local-only.
        assert!(is_sidecar_provider("openai-codex"));
        assert!(is_sidecar_provider("claude-oauth"));
        assert!(is_sidecar_provider("openai-agents"));
        assert!(!is_sidecar_provider("api-openai"));
        assert!(!is_sidecar_provider("api-claude"));
    }
}
