//! Mission Planner tool handlers (E2). Each tool is implemented in
//! its own submodule; this file routes the dispatcher to them.
//! E2-DISP scaffolds the structure; Wave-2 tool agents fill in
//! handler bodies.

pub mod complete_mission;
pub mod create_milestone;
pub mod create_task;
pub mod mark_task_blocked;
pub mod replan_after_failure;
pub mod request_user_approval;
pub mod update_task;

use tauri::{AppHandle, Manager};

use crate::commands::mission_planner::MissionPlannerRegistry;

/// Dispatch a planner tool call from the sidecar (called by
/// `MissionPlannerRegistry::handle_tool_call`). Accepts both bare tool
/// names (e.g. `create_milestone`) and the MCP-prefixed form
/// (e.g. `mcp__planner__create_milestone`).
///
/// E6-CAPS: enforces the per-mode tool-call cap BEFORE routing. The
/// registry's `bump_and_check_tool_call` atomically reads
/// `current_mode` + bumps `tool_calls_this_tick`; if the new count is
/// strictly greater than the mode's cap, this returns an error string the
/// planner sees as the tool result — the planner is expected to end the
/// current turn (no further tool calls will succeed until the next wake
/// fires, which resets the counter).
///
/// **FIX 2 — `noop` removed from production dispatch.**
/// `noop` is a JS-side smoke fixture in `mission-planner-server.ts` used
/// by `agent-sidecar/test/mcp-inproc-smoke.mjs`, which stubs the
/// Rust supervisor entirely in JS and never reaches this dispatcher. The
/// previous `noop` arm + cap bypass existed only for an older,
/// now-superseded smoke harness; carrying it forward let any planner-side
/// `noop` call slip past the per-tick cap in production. The planner's
/// system prompt explicitly tells the model not to call `noop` during
/// real work — if the model ever does, the standard "unknown planner
/// tool" error now fires, matching the production safety contract.
pub async fn dispatch(
    app: &AppHandle,
    session_id: &str,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let name = tool.strip_prefix("mcp__planner__").unwrap_or(tool);

    let registry = app
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let (mode, cap, current) = registry
        .bump_and_check_tool_call(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "no mission planner session matches sidecar session '{}'",
                session_id
            )
        })?;
    if current > cap {
        return Err(format!(
            "tool_call_cap_reached: mode={:?} count={} cap={}. End this turn — \
             the dispatcher will not accept further tool calls until the next \
             wake fires.",
            mode, current, cap
        ));
    }

    match name {
        "create_milestone" => create_milestone::handle(app, session_id, args).await,
        "create_task" => create_task::handle(app, session_id, args).await,
        "update_task" => update_task::handle(app, session_id, args).await,
        "mark_task_blocked" => mark_task_blocked::handle(app, session_id, args).await,
        "replan_after_failure" => replan_after_failure::handle(app, session_id, args).await,
        "request_user_approval" => request_user_approval::handle(app, session_id, args).await,
        "complete_mission" => complete_mission::handle(app, session_id, args).await,
        // `spawn_helper_planner` remains a v1.1 stub (see backlog); accept
        // the call but return a clear deferral message so the planner can
        // route around it.
        "spawn_helper_planner" => {
            Err("helper planner is deferred to v1.1; see backlog.md".to_string())
        }
        other => Err(format!("E2: unknown planner tool '{}'", other)),
    }
}
