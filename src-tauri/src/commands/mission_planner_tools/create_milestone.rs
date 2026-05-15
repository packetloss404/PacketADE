//! `create_milestone` tool handler.
//!
//! Owned by **E2-MILE**.
//!
//! Args shape:
//! ```json
//! { "title": string, "goal": string, "dependencies"?: string[] }
//! ```
//!
//! Returns `{ "milestoneId": string }` on success.
//!
//! Implementation note: mutates flight state via the async
//! `core::storage::with_state_lock` helper so concurrent planner-tool
//! handlers (firing in parallel within a single planner turn) can't lose
//! each other's writes. The owning mission is resolved through the
//! `MissionPlannerRegistry` reverse-lookup keyed off the sidecar
//! `session_id`.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::info;

use crate::commands::mission_planner::MissionPlannerRegistry;
use crate::core::flight::{Milestone, MilestoneStatus};
use crate::core::storage;

#[derive(Debug, Deserialize)]
struct CreateMilestoneArgs {
    title: String,
    goal: String,
    #[serde(default)]
    dependencies: Option<Vec<String>>,
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Parse args.
    let parsed: CreateMilestoneArgs = serde_json::from_value(args)
        .map_err(|e| format!("invalid args: {}", e))?;

    let title = parsed.title.trim().to_string();
    if title.is_empty() {
        return Err("invalid args: title must be non-empty".to_string());
    }
    let goal = parsed.goal;
    let dependencies = parsed.dependencies.unwrap_or_default();

    // 2. Resolve mission_id from session_id via the registry reverse-lookup.
    //    This is the canonical way to map sidecar session ids back to
    //    missions (see `update_task.rs` for the reference pattern). A miss
    //    here means the planner has been torn down between SDK tool
    //    dispatch and now, which we surface as an error so the SDK doesn't
    //    happily append to a mission whose planner is gone.
    let registry = app
        .try_state::<MissionPlannerRegistry>()
        .ok_or_else(|| "mission planner registry not managed".to_string())?;

    let mission_id = registry
        .mission_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| format!("planner session '{}' not found in registry", session_id))?;

    // 3. Mutate state under the async lock so parallel planner-tool handlers
    //    can't lose each other's writes. The mutation runs synchronously
    //    inside the closure body and we return an async block that's
    //    independent of `state`'s borrow — this sidesteps a Rust lifetime
    //    inference limitation with `FnOnce(&mut _) -> impl Future` (Rust
    //    can't yet infer that the returned Future may only outlive the
    //    `&mut` borrow). Tauri emits and the journal log line happen
    //    AFTER the lock releases.
    let milestone_id = format!("ms_{}", uuid::Uuid::new_v4());
    let now = now_millis();
    let mission_id_for_closure = mission_id.clone();
    let milestone_id_for_closure = milestone_id.clone();
    let title_for_closure = title.clone();

    storage::with_state_lock(move |state| {
        let mission_id = mission_id_for_closure;
        let milestone_id = milestone_id_for_closure;
        let title = title_for_closure;
        let goal = goal;
        let dependencies = dependencies;
        let outcome: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == mission_id)
                .ok_or_else(|| "flight not found".to_string())?;

            let order = flight.milestones.len();
            let milestone = Milestone {
                id: milestone_id,
                flight_id: mission_id,
                title,
                description: goal,
                order,
                status: MilestoneStatus::Pending,
                tasks: Vec::new(),
                validation_criteria: dependencies,
            };
            flight.milestones.push(milestone);
            flight.updated_at = now;
            Ok(())
        })();
        async move { outcome }
    })
    .await
    .map_err(|e| format!("failed to persist milestone: {}", e))?;

    // 4. Journal: log line for offline traceability + a Tauri event the UI
    // can subscribe to so the Live Timeline lights up. Event name follows
    // the existing `mission-planner:*:<missionId>` convention used by the
    // approval-gate path. The payload carries enough for the UI to either
    // hydrate from persisted state or render an optimistic entry.
    info!(
        mission_id = %mission_id,
        milestone_id = %milestone_id,
        title = %title,
        "mission planner created milestone"
    );
    let _ = app.emit(
        &format!("mission-planner:milestone-created:{}", mission_id),
        serde_json::json!({
            "missionId": mission_id,
            "milestoneId": milestone_id,
            "title": title,
            "createdAt": now,
        }),
    );

    // 5. Return.
    Ok(serde_json::json!({ "milestoneId": milestone_id }))
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
        let v = serde_json::json!({
            "title": "Wire up planner tools",
            "goal": "Land all 7 MCP tool handlers.",
        });
        let parsed: CreateMilestoneArgs = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.title, "Wire up planner tools");
        assert_eq!(parsed.goal, "Land all 7 MCP tool handlers.");
        assert!(parsed.dependencies.is_none());
    }

    #[test]
    fn deserializes_with_dependencies() {
        let v = serde_json::json!({
            "title": "Milestone B",
            "goal": "Depends on A.",
            "dependencies": ["ms_aaa", "ms_bbb"],
        });
        let parsed: CreateMilestoneArgs = serde_json::from_value(v).unwrap();
        assert_eq!(
            parsed.dependencies.as_deref(),
            Some(&["ms_aaa".to_string(), "ms_bbb".to_string()][..])
        );
    }

    #[test]
    fn rejects_missing_required_fields() {
        let v = serde_json::json!({ "title": "no goal" });
        let res: Result<CreateMilestoneArgs, _> = serde_json::from_value(v);
        assert!(res.is_err());
    }
}
