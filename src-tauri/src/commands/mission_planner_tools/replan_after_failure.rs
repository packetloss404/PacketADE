//! `replan_after_failure` tool handler.
//!
//! Owned by **E2-REPL-COMP** (paired with `complete_mission`).
//!
//! Args shape:
//! ```json
//! { "task_id": string }
//! ```
//!
//! Acknowledges a failed task and signals the planner that it should add a
//! new task subtree under the same milestone. The handler:
//!   * Bumps `replans_per_task[task_id]` on the live planner session.
//!   * Returns `Err("max_replans_reached: …")` once the per-task counter
//!     exceeds 3 (flat cap; per the locked spec the RateLimit / Network
//!     exemption is **E5's** job and wraps this handler from above).
//!   * Marks the failed task `TaskStatus::Cancelled` so it stops haunting
//!     the milestone-progress rollup.
//!   * Reports the parent milestone id so the planner knows where to add
//!     replacement tasks via `create_task`.
//!
//! Returns:
//! ```json
//! {
//!   "ready_for_new_tasks": true,
//!   "parent_milestone_id": string,
//!   "replan_count": number
//! }
//! ```

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::commands::mission_planner::MissionPlannerRegistry;
use crate::core::flight::TaskStatus;
use crate::core::storage;

/// Flat per-task replan ceiling. Matches the locked design. E5 wraps this
/// handler with an error-category check that exempts RateLimit / Network
/// failures — that exemption is *not* this slice's responsibility.
const MAX_REPLANS_PER_TASK: u32 = 3;

#[derive(Debug, Deserialize)]
struct ReplanAfterFailureArgs {
    task_id: String,
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Parse args.
    let parsed: ReplanAfterFailureArgs = serde_json::from_value(args)
        .map_err(|e| format!("invalid args: {}", e))?;
    let task_id = parsed.task_id.trim();
    if task_id.is_empty() {
        return Err("invalid args: task_id must be non-empty".to_string());
    }

    // 2. Resolve mission_id from sidecar session_id via the registry.
    let registry = app
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;
    let mission_id = registry
        .mission_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "no active planner session found for sidecar session '{}'",
                session_id
            )
        })?;

    // 3. Bump the per-task replan counter on the planner session.
    //    `bump_replan_count` mutates `MissionPlannerSession.replans_per_task`
    //    in place under the registry's async Mutex and returns the new count.
    let new_count = registry
        .bump_replan_count(&mission_id, task_id)
        .await
        .ok_or_else(|| {
            format!(
                "planner session for mission '{}' disappeared between resolve and replan",
                mission_id
            )
        })?;

    // 4. Enforce the flat cap.
    if new_count > MAX_REPLANS_PER_TASK {
        return Err(format!(
            "max_replans_reached: task {} has been replanned {} times. Use request_user_approval to escalate to the user.",
            task_id, MAX_REPLANS_PER_TASK
        ));
    }

    // 5. Mark the failed task Cancelled and capture its parent milestone id.
    //    Registry mutations (step 3) already happened OUTSIDE the lock — they
    //    use the registry's own Mutex, not the PersistedState lock. Only the
    //    state-mutating step belongs inside `with_state_lock`.
    //    Synchronous inner closure + `std::future::ready` avoids the HRTB
    //    lifetime issue the helper's signature can't express. Event emit
    //    happens OUTSIDE the lock.
    let now = now_millis();
    let mission_id_for_closure = mission_id.clone();
    let task_id_for_closure = task_id.to_string();
    let parent_milestone_id = storage::with_state_lock(move |state| {
        let mission_id = mission_id_for_closure;
        let task_id = task_id_for_closure;
        let result: Result<String, String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == mission_id)
                .ok_or_else(|| format!("flight not found for mission '{}'", mission_id))?;

            let mut found: Option<String> = None;
            for milestone in flight.milestones.iter_mut() {
                if let Some(task) = milestone.tasks.iter_mut().find(|t| t.id == task_id) {
                    task.status = TaskStatus::Cancelled;
                    task.completed_at = Some(now);
                    found = Some(milestone.id.clone());
                    break;
                }
            }
            flight.updated_at = now;
            found.ok_or_else(|| {
                format!("task '{}' not found in mission '{}'", task_id, mission_id)
            })
        })();
        std::future::ready(result)
    })
    .await
    .map_err(|e| format!("failed to persist task cancellation: {}", e))?;

    // 6. Coordination event so the UI can light up "planner is replanning"
    //    state. Mirrors the `mission-planner:*:<missionId>` convention used
    //    by the milestone/approval paths.
    info!(
        mission_id = %mission_id,
        task_id = %task_id,
        replan_count = new_count,
        parent_milestone_id = %parent_milestone_id,
        "mission planner acknowledged task replan"
    );
    let event_name = format!("mission-planner:task-replan-acknowledged:{}", mission_id);
    if let Err(e) = app.emit(
        &event_name,
        serde_json::json!({
            "missionId": mission_id,
            "taskId": task_id,
            "parentMilestoneId": parent_milestone_id,
            "replanCount": new_count,
            "acknowledgedAt": now,
        }),
    ) {
        warn!(error = %e, event = %event_name, "failed to emit replan-acknowledged event");
    }

    // 7. Return.
    Ok(serde_json::json!({
        "ready_for_new_tasks": true,
        "parent_milestone_id": parent_milestone_id,
        "replan_count": new_count,
    }))
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

    #[test]
    fn deserializes_minimal_args() {
        let v = serde_json::json!({ "task_id": "task_abc" });
        let parsed: ReplanAfterFailureArgs = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.task_id, "task_abc");
    }

    #[test]
    fn rejects_missing_task_id() {
        let v = serde_json::json!({});
        let res: Result<ReplanAfterFailureArgs, _> = serde_json::from_value(v);
        assert!(res.is_err());
    }

    #[test]
    fn cap_is_three() {
        assert_eq!(MAX_REPLANS_PER_TASK, 3);
    }
}
