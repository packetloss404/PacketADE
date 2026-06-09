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
//! Returns `{ "ok": true, "updated_fields": string[],
//! "deferred_fields": string[] }` on success. `deferred_fields` lists
//! patch keys we accepted but could NOT persist on the Task model yet
//! (currently just `target_spec`) — the planner must treat these as
//! *not landed* rather than applied.

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::commands::mission_planner::MissionPlannerRegistry;
use crate::core::flight::{Task, TaskStatus};
use crate::core::storage;

#[derive(Debug, Deserialize)]
struct Args {
    task_id: String,
    #[serde(default)]
    patch: Value,
}

pub async fn handle(app: &AppHandle, session_id: &str, args: Value) -> Result<Value, String> {
    let parsed: Args =
        serde_json::from_value(args).map_err(|e| format!("update_task: invalid args: {}", e))?;

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
    let (updated_fields, deferred_fields) = storage::with_state_lock(move |state| {
        let mission_id = mission_id_for_closure;
        let task_id = task_id_for_closure;
        let patch_obj = patch_obj;
        let result: Result<(Vec<String>, Vec<String>), String> = (move || {
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

            let (updated_fields, deferred_fields) = apply_patch_to_task(task, patch_obj)?;
            flight.updated_at = now_millis();
            Ok((updated_fields, deferred_fields))
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
            "deferredFields": deferred_fields.clone(),
        }),
    );

    Ok(serde_json::json!({
        "ok": true,
        "updated_fields": updated_fields,
        "deferred_fields": deferred_fields,
    }))
}

fn apply_patch_to_task(
    task: &mut Task,
    patch_obj: serde_json::Map<String, Value>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let mut updated_fields: Vec<String> = Vec::new();
    let mut deferred_fields: Vec<String> = Vec::new();

    for (key, value) in patch_obj.into_iter() {
        match key.as_str() {
            "title" => match value.as_str() {
                Some(s) => {
                    task.title = s.to_string();
                    updated_fields.push("title".to_string());
                }
                None => return Err("update_task: 'title' must be a string".to_string()),
            },
            // The Task struct stores the executor prompt under `description`
            // because that field is what the async-attempts launcher feeds
            // into the agent session. The planner-facing alias is `prompt`.
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
                None => return Err("update_task: 'agent_id' must be a string".to_string()),
            },
            // `target_spec` carries the async-attempts AttemptTargetSpec
            // shape. There's no dedicated field on Task yet (the
            // attempt-launcher reads the per-attempt target directly off
            // `Flight::attempts`), so we have nowhere to land it on the Task
            // model. We must NOT report it in `updated_fields` — doing so
            // would tell the planner the change persisted when it silently
            // dropped. Instead we surface it in `deferred_fields` so the
            // planner knows the patch was accepted-but-not-applied. The
            // launch-time wiring (E4+) will pick the target up at
            // attempt-creation time once Task gains a field to hold it.
            "target_spec" => {
                deferred_fields.push("target_spec".to_string());
                // No mutation — see comment above. Field is intentionally
                // not persisted.
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

    Ok((updated_fields, deferred_fields))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::flight::{ReviewPacket, TaskResult, TaskType};

    fn fixture_task() -> Task {
        Task {
            id: "task_1".to_string(),
            milestone_id: "ms_1".to_string(),
            flight_id: "mission_1".to_string(),
            title: "Old title".to_string(),
            description: "Old prompt".to_string(),
            order: 0,
            status: TaskStatus::Queued,
            task_type: TaskType::Implementation,
            agent_config_id: "old-agent".to_string(),
            agent_args: None,
            model: None,
            depends_on: Vec::new(),
            session_id: None,
            result: None::<TaskResult>,
            review_packet: None::<ReviewPacket>,
            created_at: 0,
            started_at: None,
            completed_at: None,
            cost: 0.0,
            tokens: 0,
            owned_paths: Vec::new(),
            replan_count: 0,
        }
    }

    fn patch_object(value: Value) -> serde_json::Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("test patch must be a JSON object"),
        }
    }

    #[test]
    fn target_spec_is_deferred_while_patch_fields_persist() {
        let mut task = fixture_task();
        let patch = patch_object(serde_json::json!({
            "title": "New title",
            "prompt": "New executor prompt",
            "agent_id": "codex-cli",
            "status": "cancelled",
            "target_spec": {
                "kind": "local",
                "basePath": "D:/projects/PacketADE",
                "baseBranch": "main",
                "agentConfigId": "codex-cli",
                "provider": "codex-oauth",
                "model": "gpt-5"
            }
        }));

        let (updated_fields, deferred_fields) =
            apply_patch_to_task(&mut task, patch).expect("patch should apply");

        assert_eq!(deferred_fields, vec!["target_spec".to_string()]);
        assert!(
            !updated_fields.iter().any(|field| field == "target_spec"),
            "target_spec must not be reported as persisted"
        );
        for expected in ["title", "prompt", "agent_id", "status"] {
            assert!(
                updated_fields.iter().any(|field| field == expected),
                "{expected} should be reported in updated_fields"
            );
        }
        assert_eq!(updated_fields.len(), 4);

        assert_eq!(task.title, "New title");
        assert_eq!(task.description, "New executor prompt");
        assert_eq!(task.agent_config_id, "codex-cli");
        assert_eq!(task.status, TaskStatus::Cancelled);
    }
}
