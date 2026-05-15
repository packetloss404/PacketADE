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

use tauri::AppHandle;

/// Dispatch a planner tool call from the sidecar (called by
/// `MissionPlannerRegistry::handle_tool_call`). Accepts both bare tool
/// names (e.g. `create_milestone`) and the MCP-prefixed form
/// (e.g. `mcp__planner__create_milestone`).
///
/// The `noop` arm is preserved from E1 so the existing protocol-v5
/// round-trip smoke keeps passing; it is the one "always-available"
/// stub even after the rest of the surface lands.
pub async fn dispatch(
    app: &AppHandle,
    session_id: &str,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let name = tool.strip_prefix("mcp__planner__").unwrap_or(tool);
    match name {
        "noop" => Ok(serde_json::json!({
            "ok": true,
            "message": args.get("message").cloned().unwrap_or_default(),
        })),
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
