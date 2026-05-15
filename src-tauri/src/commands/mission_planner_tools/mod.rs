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
    // Resolve the owning mission_id BEFORE dispatch so terminal tools
    // (`complete_mission` removes the planner session from the registry on
    // its success path) still have a mission_id to journal under after
    // they return.
    let mission_id_at_dispatch = registry
        .mission_id_for_sidecar_session(session_id)
        .await;

    if current > cap {
        let err_msg = format!(
            "tool_call_cap_reached: mode={:?} count={} cap={}. End this turn — \
             the dispatcher will not accept further tool calls until the next \
             wake fires.",
            mode, current, cap
        );
        // E7-HOOKS site 3 (cap-reject path) — journal cap-rejections so the
        // planner's timeline shows the throttle.
        //
        // E7-DEDUP: skip the generic `ToolCall` entry for
        // `request_user_approval`. The dedicated `ApprovalRequest` entry
        // written by the handler is the canonical record for that tool, and
        // a double entry confuses the timeline. (For the cap-reject path the
        // handler never runs, so technically nothing is duplicated here —
        // but we keep the skip uniform with the post-dispatch branch below
        // so `request_user_approval` only ever produces `ApprovalRequest`
        // entries, never `ToolCall`.)
        if let Some(ref mission_id) = mission_id_at_dispatch {
            if name != "request_user_approval" {
                journal_tool_call(
                    app,
                    mission_id,
                    name,
                    &args,
                    None,
                    Some(&err_msg),
                )
                .await;
            }
        }
        return Err(err_msg);
    }

    let outcome = match name {
        "create_milestone" => create_milestone::handle(app, session_id, args.clone()).await,
        "create_task" => create_task::handle(app, session_id, args.clone()).await,
        "update_task" => update_task::handle(app, session_id, args.clone()).await,
        "mark_task_blocked" => mark_task_blocked::handle(app, session_id, args.clone()).await,
        "replan_after_failure" => replan_after_failure::handle(app, session_id, args.clone()).await,
        "request_user_approval" => request_user_approval::handle(app, session_id, args.clone()).await,
        "complete_mission" => complete_mission::handle(app, session_id, args.clone()).await,
        // `spawn_helper_planner` remains a v1.1 stub (see backlog); accept
        // the call but return a clear deferral message so the planner can
        // route around it.
        "spawn_helper_planner" => {
            Err("helper planner is deferred to v1.1; see backlog.md".to_string())
        }
        other => Err(format!("E2: unknown planner tool '{}'", other)),
    };

    // E7-HOOKS site 3 — journal every dispatched tool call (success OR
    // logical error). Per the E7 spec we SKIP entries that are pure
    // args-parsing failures (those represent invalid input, not a real
    // tool call) — handlers tag those with the literal "invalid args:"
    // prefix. Everything else (success values, logical errors, the
    // `spawn_helper_planner` deferral, the "unknown planner tool" arm) is
    // journaled.
    //
    // Use the mission_id captured BEFORE dispatch so terminal tools
    // (`complete_mission` removes the planner session as part of its
    // success flip) still land their journal entry.
    //
    // E7-DEDUP: `request_user_approval` already writes its own dedicated
    // `ApprovalRequest` journal entry from inside the handler — skip the
    // generic `ToolCall` entry for that one tool so the timeline doesn't
    // show the same approval twice (one as ToolCall + one as
    // ApprovalRequest). All other tools journal normally.
    if let Some(ref mission_id) = mission_id_at_dispatch {
        if name != "request_user_approval" {
            match &outcome {
                Ok(v) => {
                    journal_tool_call(
                        app,
                        mission_id,
                        name,
                        &args,
                        Some(v),
                        None,
                    )
                    .await;
                }
                Err(e) if e.starts_with("invalid args:") => {
                    // Skip — args-parse failure, not a real tool call.
                }
                Err(e) => {
                    journal_tool_call(
                        app,
                        mission_id,
                        name,
                        &args,
                        None,
                        Some(e.as_str()),
                    )
                    .await;
                }
            }
        }
    }

    outcome
}

/// E7-HOOKS — build and append a ToolCall journal entry.
///
/// `result` is the success payload (Some) and `error` is the failure
/// message (Some); exactly one is expected to be `Some` per call. The
/// markdown body summarizes the tool name, args, and outcome; metadata
/// carries the full args + full result JSON for downstream analyses.
async fn journal_tool_call(
    app: &AppHandle,
    mission_id: &str,
    tool_name: &str,
    args: &serde_json::Value,
    result: Option<&serde_json::Value>,
    error: Option<&str>,
) {
    use crate::commands::mission_planner::{journal_entry, write_journal_and_emit};
    use crate::core::mission_journal::JournalKind;

    let args_pretty = serde_json::to_string_pretty(args).unwrap_or_else(|_| "{}".to_string());
    let args_snippet = truncate(&args_pretty, 500);

    let (outcome_tag, outcome_line) = match (result, error) {
        (Some(v), _) => {
            let preview = match v {
                serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                    truncate(
                        &serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()),
                        180,
                    )
                }
                serde_json::Value::String(s) => truncate(s, 180),
                other => other.to_string(),
            };
            ("ok", preview)
        }
        (None, Some(e)) => ("err", truncate(e, 180)),
        (None, None) => ("ok", String::new()),
    };

    let body = format!(
        "**tool**: `{}`\n**args**: {}\n**result**: {} — {}",
        tool_name, args_snippet, outcome_tag, outcome_line,
    );
    let metadata = serde_json::json!({
        "tool": tool_name,
        "args": args,
        "result": result,
        "error": error,
    });
    let entry = journal_entry(
        mission_id.to_string(),
        JournalKind::ToolCall,
        body,
        Some(metadata),
    );
    write_journal_and_emit(app, entry).await;
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("…");
    out
}
