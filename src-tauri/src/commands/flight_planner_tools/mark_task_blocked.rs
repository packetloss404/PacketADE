//! `mark_task_blocked` tool handler.
//!
//! Owned by **E2-UPD-BLOCK** (paired with `update_task`).
//!
//! Args shape:
//! ```json
//! { "task_id": string, "reason": string }
//! ```
//!
//! Flips the task's status to `TaskStatus::Blocked` and surfaces the
//! reason via a Tauri event. The `Task` struct does not (yet) carry a
//! `blocked_reason` field on the wire — the locked design's v1 surface
//! routes the reason through a coordination event rather than mutating
//! the DTO, so the frontend's `CoordinationEvent` log picks it up
//! without a DTO bump. (See E2-UPD-BLOCK BLOCKER note in the report:
//! we found no `blocked_reason` field on `core::flight::Task`, so we
//! followed the spec's documented fallback path — emit the reason on
//! the coordination event channel.)
//!
//! Returns `{ "ok": true }` on success.

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::flight_planner::FlightPlannerRegistry;
use crate::core::flight::TaskStatus;
use crate::core::storage;

#[derive(Debug, Deserialize)]
struct Args {
    task_id: String,
    reason: String,
}

pub async fn handle(app: &AppHandle, session_id: &str, args: Value) -> Result<Value, String> {
    let parsed: Args = serde_json::from_value(args)
        .map_err(|e| format!("mark_task_blocked: invalid args: {}", e))?;

    // Resolve the owning flight via the registry.
    let registry = app
        .try_state::<FlightPlannerRegistry>()
        .ok_or_else(|| "flight planner registry not managed".to_string())?;
    let flight_id = registry
        .flight_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "mark_task_blocked: no active planner session for sidecar session '{}'",
                session_id
            )
        })?;

    // Wrap the load-mutate-save composite in `with_state_lock` to
    // serialize concurrent planner tool calls. The mutation runs in a
    // synchronous inner closure that returns a `Ready` future so the
    // future doesn't capture a `&mut state` borrow (the helper's
    // signature can't express that with HRTBs today). Event emit
    // happens OUTSIDE the lock.
    let flight_id_for_closure = flight_id.clone();
    let task_id_for_closure = parsed.task_id.clone();
    storage::with_state_lock(move |state| {
        let flight_id = flight_id_for_closure;
        let task_id = task_id_for_closure;
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("mark_task_blocked: flight '{}' not found", flight_id))?;

            let task = flight
                .milestones
                .iter_mut()
                .find_map(|m| m.tasks.iter_mut().find(|t| t.id == task_id))
                .ok_or_else(|| "task not found".to_string())?;

            task.status = TaskStatus::Blocked;
            flight.updated_at = now_millis();
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
    .map_err(|e| format!("mark_task_blocked: {}", e))?;

    // Emit a Tauri event carrying the reason. The frontend's planner
    // listener fans this into the per-flight coordination log so the
    // Journal/Timeline tabs see the block.
    let _ = app.emit(
        &format!("flight-planner:task-blocked:{}", flight_id),
        serde_json::json!({
            "flightId": flight_id,
            "taskId": parsed.task_id,
            "reason": parsed.reason,
        }),
    );

    Ok(serde_json::json!({ "ok": true }))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}
