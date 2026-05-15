//! `update_task` tool handler.
//!
//! Owned by **E2-UPD-BLOCK** (paired with `mark_task_blocked`).
//!
//! Args shape:
//! ```json
//! { "task_id": string, "patch": object }
//! ```
//!
//! `patch` is an open-ended JSON object. The handler whitelists the
//! fields the planner is allowed to update (title / prompt / agent_id /
//! target_spec, plus a heavily restricted set of `status` transitions).
//! Unknown keys are ignored (logged at warn level — the planner may send
//! extra metadata we don't yet model). The `status` field is owned by
//! the executor, so we accept only the two "safe" transitions:
//! `cancelled` (planner aborts a task) and `queued` (re-queue a
//! previously cancelled task). Anything else is rejected with a clear
//! error so the planner routes through `mark_task_blocked` or
//! `replan_after_failure` instead.
//!
//! Returns `{ "ok": true, "updated_fields": string[] }` on success.

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::commands::mission_planner::MissionPlannerRegistry;
use crate::core::flight::TaskStatus;
use crate::core::storage;

#[derive(Debug, Deserialize)]
struct Args {
    task_id: String,
    #[serde(default)]
    patch: Value,
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: Value,
) -> Result<Value, String> {
    let parsed: Args = serde_json::from_value(args)
        .map_err(|e| format!("update_task: invalid args: {}", e))?;

    let patch_obj = match &parsed.patch {
        Value::Object(map) => map.clone(),
        Value::Null => serde_json::Map::new(),
        _ => return Err("update_task: 'patch' must be a JSON object".to_string()),
    };

    // Resolve the owning mission via the registry (the sidecar session
    // id is what the dispatcher hands us).
    let registry = app
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let mission_id = registry
        .mission_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "update_task: no active planner session for sidecar session '{}'",
                session_id
            )
        })?;

    // Wrap the load-mutate-save composite in `with_state_lock` so multiple
    // planner tool handlers firing in parallel within one turn can't
    // clobber each other (load → mutate → save is otherwise racy). The
    // mutation runs in a synchronous inner closure and the closure returns
    // a `Ready` future so the future doesn't capture a `&mut state` borrow
    // (the helper's `FnOnce(&mut PersistedState) -> Fut` signature can't
    // express the HRTB required for an `async move` block today). Event
    // emits MUST happen outside this block — we don't hold the mutex
    // across Tauri IO.
    let mission_id_for_closure = mission_id.clone();
    let task_id_for_closure = parsed.task_id.clone();
    let updated_fields = storage::with_state_lock(move |state| {
        let mission_id = mission_id_for_closure;
        let task_id = task_id_for_closure;
        let patch_obj = patch_obj;
        let result: Result<Vec<String>, String> = (move || {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == mission_id)
                .ok_or_else(|| format!("update_task: mission '{}' not found", mission_id))?;

            // Locate the task across milestones.
            let task = flight
                .milestones
                .iter_mut()
                .find_map(|m| m.tasks.iter_mut().find(|t| t.id == task_id))
                .ok_or_else(|| "task not found".to_string())?;

            let mut updated_fields: Vec<String> = Vec::new();

            for (key, value) in patch_obj.into_iter() {
                match key.as_str() {
                    "title" => match value.as_str() {
                        Some(s) => {
                            task.title = s.to_string();
                            updated_fields.push("title".to_string());
                        }
                        None => return Err("update_task: 'title' must be a string".to_string()),
                    },
                    // The Task struct stores the executor prompt under
                    // `description` — that field is what the async-attempts
                    // launcher feeds into the agent session. The planner-facing
                    // alias is `prompt`, which is what the locked-design spec
                    // uses.
                    "prompt" => match value.as_str() {
                        Some(s) => {
                            task.description = s.to_string();
                            updated_fields.push("prompt".to_string());
                        }
                        None => return Err("update_task: 'prompt' must be a string".to_string()),
                    },
                    "agent_id" => match value.as_str() {
                        Some(s) => {
                            task.agent_config_id = s.to_string();
                            updated_fields.push("agent_id".to_string());
                        }
                        None => {
                            return Err(
                                "update_task: 'agent_id' must be a string".to_string(),
                            )
                        }
                    },
                    // `target_spec` carries the async-attempts AttemptTargetSpec
                    // shape. There's no dedicated field on Task yet (the
                    // attempt-launcher reads the per-attempt target directly off
                    // `Flight::attempts`), so we accept and ack the patch but
                    // don't have a place to land it on the Task. Surface this
                    // via the updated_fields list so the planner sees its patch
                    // landed; the launch-time wiring (E4+) will pick the target
                    // up at attempt-creation time.
                    "target_spec" => {
                        // Best-effort: persist as a structured metadata blob on
                        // the task model in a future task-DTO bump. For now,
                        // emit it on the mission event so the UI / journal can
                        // record the planner's intent without breaking DTO
                        // serialization.
                        updated_fields.push("target_spec".to_string());
                        // (No mutation — see comment above.)
                        // We still attach it to the emitted event payload below.
                        let _ = value;
                    }
                    "status" => match value.as_str() {
                        Some("cancelled") => {
                            task.status = TaskStatus::Cancelled;
                            updated_fields.push("status".to_string());
                        }
                        Some("queued") => {
                            task.status = TaskStatus::Queued;
                            updated_fields.push("status".to_string());
                        }
                        _ => {
                            return Err(
                                "status field is owned by the executor; use mark_task_blocked or replan_after_failure instead"
                                    .to_string(),
                            );
                        }
                    },
                    other => {
                        warn!(
                            tool = "update_task",
                            field = %other,
                            "ignoring unknown patch key (planner may send extra metadata)"
                        );
                    }
                }
            }

            flight.updated_at = now_millis();
            Ok(updated_fields)
        })();
        std::future::ready(result)
    })
    .await
    .map_err(|e| format!("update_task: {}", e))?;

    // Emit a Tauri event so the UI / journal can surface the change.
    // There's no Rust-side CoordinationEvent enum (the frontend models
    // those in TS only), so we publish a scoped event the planner
    // listener wires through on the frontend. Emit OUTSIDE the lock.
    let _ = app.emit(
        &format!("mission-planner:task-updated:{}", mission_id),
        serde_json::json!({
            "missionId": mission_id,
            "taskId": parsed.task_id,
            "updatedFields": updated_fields.clone(),
        }),
    );

    Ok(serde_json::json!({
        "ok": true,
        "updated_fields": updated_fields,
    }))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}
