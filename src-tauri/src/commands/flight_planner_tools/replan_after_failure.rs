//! `replan_after_failure` tool handler.
//!
//! Owned by **E2-REPL-COMP** (paired with `complete_flight`). The E5-REPLAN
//! slice layered the error-category exemption on top: RateLimit / Network
//! failures (per [`AiErrorCategory`]) do **not** count against the per-task
//! replan cap (`MAX_REPLANS_PER_TASK = 3`).
//!
//! Args shape:
//! ```json
//! { "task_id": string }
//! ```
//!
//! Acknowledges a failed task and signals the planner that it should add a
//! new task subtree under the same milestone. The handler:
//!   * Classifies the failed task's last recorded error via
//!     [`error_classifier::classify_task_last_error`].
//!   * If the category is **replan-exempt** (RateLimit / Timeout — the
//!     "Network" bucket from the locked design), skips both the counter
//!     bump and the cap check entirely; the failed task is still cancelled
//!     so the planner replaces it.
//!   * Otherwise bumps `replans_per_task[task_id]` on the live planner
//!     session and returns `Err("max_replans_reached: …")` once the new
//!     count exceeds 3.
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
//!   "replan_count": number,
//!   "exempt": boolean,
//!   "error_category": string | null
//! }
//! ```

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::commands::flight_planner::FlightPlannerRegistry;
use crate::core::error_classifier::{self, AiErrorCategory};
use crate::core::flight::TaskStatus;
use crate::core::storage;

/// Flat per-task replan ceiling. Matches the locked design. The E5-REPLAN
/// slice wraps the bump in an error-category exemption check so RateLimit /
/// Network failures don't tick against this cap.
const MAX_REPLANS_PER_TASK: u32 = 3;

#[derive(Debug, Deserialize)]
struct ReplanAfterFailureArgs {
    task_id: String,
}

/// Format an [`AiErrorCategory`] as a stable snake_case string for the
/// tool response. We piggyback on the serde derivation
/// (`#[serde(rename_all = "snake_case")]`) so the wire shape here is
/// guaranteed to match the rest of the codebase if/when other consumers
/// serialize the same enum.
fn category_to_string(cat: AiErrorCategory) -> String {
    serde_json::to_value(cat)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        // Fallback should be unreachable because all variants serialize
        // to a string, but keep a deterministic last-resort form rather
        // than panicking if serde_json ever surprises us.
        .unwrap_or_else(|| format!("{:?}", cat).to_ascii_lowercase())
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Parse args.
    let parsed: ReplanAfterFailureArgs =
        serde_json::from_value(args).map_err(|e| format!("invalid args: {}", e))?;
    let task_id = parsed.task_id.trim();
    if task_id.is_empty() {
        return Err("invalid args: task_id must be non-empty".to_string());
    }

    // 2. Resolve flight_id from sidecar session_id via the registry.
    let registry = app
        .try_state::<FlightPlannerRegistry>()
        .ok_or_else(|| "flight planner registry not managed".to_string())?;
    let flight_id = registry
        .flight_id_for_sidecar_session(session_id)
        .await
        .ok_or_else(|| {
            format!(
                "no active planner session found for sidecar session '{}'",
                session_id
            )
        })?;

    // 3. Classify the failed task's last error so we can decide whether
    //    this replan is exempt from the per-task cap. We do this off a
    //    read-only snapshot of PersistedState — no lock needed; the
    //    subsequent state-cancel step takes its own `with_state_lock`. If
    //    the task isn't found here, we surface that error early; the cancel
    //    step would surface the same error anyway, but eagerly checking
    //    avoids bumping the counter for a task that doesn't exist.
    let error_category: Option<AiErrorCategory> = {
        let state = storage::load_state();
        let flight = state
            .flights
            .iter()
            .find(|f| f.id == flight_id)
            .ok_or_else(|| format!("flight not found for flight '{}'", flight_id))?;
        let task = flight
            .milestones
            .iter()
            .flat_map(|m| m.tasks.iter())
            .find(|t| t.id == task_id)
            .ok_or_else(|| format!("task '{}' not found in flight '{}'", task_id, flight_id))?;
        error_classifier::classify_task_last_error(task)
    };

    // 4. Decide exempt vs. counted. Per the locked spec
    //    (`dev/flight-planner-plan.md`):
    //      "Replans per task: 3 — RateLimit / Network errors do NOT count"
    let was_exempt = error_category
        .map(|c| error_classifier::is_replan_exempt(&c))
        .unwrap_or(false);

    // 5. Drive the counter according to exemption status.
    //    Exempt path: read the current count without mutating.
    //    Counted path: bump and enforce the flat cap.
    let replan_count = if was_exempt {
        registry
            .read_replan_count(&flight_id, task_id)
            .await
            .ok_or_else(|| {
                format!(
                    "planner session for flight '{}' disappeared between resolve and replan",
                    flight_id
                )
            })?
    } else {
        let new_count = registry
            .bump_replan_count(&flight_id, task_id)
            .await
            .ok_or_else(|| {
                format!(
                    "planner session for flight '{}' disappeared between resolve and replan",
                    flight_id
                )
            })?;
        if new_count > MAX_REPLANS_PER_TASK {
            return Err(format!(
                "max_replans_reached: task {} has been replanned {} times. Use request_user_approval to escalate to the user.",
                task_id, MAX_REPLANS_PER_TASK
            ));
        }
        new_count
    };

    // 6. Mark the failed task Cancelled and capture its parent milestone id.
    //    Even exempt failures get cancelled — the planner is going to
    //    replace the task either way; the exemption only governs the cap.
    //    Synchronous inner closure + `std::future::ready` avoids the HRTB
    //    lifetime issue the helper's signature can't express. Event emit
    //    happens OUTSIDE the lock.
    let now = now_millis();
    let flight_id_for_closure = flight_id.clone();
    let task_id_for_closure = task_id.to_string();
    let parent_milestone_id = storage::with_state_lock(move |state| {
        let flight_id = flight_id_for_closure;
        let task_id = task_id_for_closure;
        let result: Result<String, String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("flight not found for flight '{}'", flight_id))?;

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
            found.ok_or_else(|| format!("task '{}' not found in flight '{}'", task_id, flight_id))
        })();
        std::future::ready(result)
    })
    .await
    .map_err(|e| format!("failed to persist task cancellation: {}", e))?;

    // 7. Coordination event so the UI can light up "planner is replanning"
    //    state. Mirrors the `flight-planner:*:<flightId>` convention used
    //    by the milestone/approval paths. Includes the exempt flag + the
    //    classified error category so the UI can label exempt replans
    //    distinctly ("retried after rate limit") from cap-eating ones.
    let error_category_str: Option<String> = error_category.map(category_to_string);
    info!(
        flight_id = %flight_id,
        task_id = %task_id,
        replan_count = replan_count,
        exempt = was_exempt,
        error_category = ?error_category_str,
        parent_milestone_id = %parent_milestone_id,
        "flight planner acknowledged task replan"
    );
    let event_name = format!("flight-planner:task-replan-acknowledged:{}", flight_id);
    if let Err(e) = app.emit(
        &event_name,
        serde_json::json!({
            "flightId": flight_id,
            "taskId": task_id,
            "parentMilestoneId": parent_milestone_id,
            "replanCount": replan_count,
            "exempt": was_exempt,
            "errorCategory": error_category_str,
            "acknowledgedAt": now,
        }),
    ) {
        warn!(error = %e, event = %event_name, "failed to emit replan-acknowledged event");
    }

    // 8. Return.
    Ok(serde_json::json!({
        "ready_for_new_tasks": true,
        "parent_milestone_id": parent_milestone_id,
        "replan_count": replan_count,
        "exempt": was_exempt,
        "error_category": error_category_str,
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

    /// The response/event payload exposes the classified error category as a
    /// stable snake_case string. Verify each variant round-trips through
    /// [`category_to_string`] to the form callers (and the planner system
    /// prompt) expect — the sidecar journal renders this verbatim, so a
    /// stray `Debug`-style "RateLimit" would leak Rust internals into the
    /// model context.
    #[test]
    fn category_to_string_uses_snake_case_for_every_variant() {
        assert_eq!(category_to_string(AiErrorCategory::Auth), "auth");
        assert_eq!(category_to_string(AiErrorCategory::Billing), "billing");
        assert_eq!(category_to_string(AiErrorCategory::RateLimit), "rate_limit");
        assert_eq!(
            category_to_string(AiErrorCategory::ContextOverflow),
            "context_overflow"
        );
        assert_eq!(category_to_string(AiErrorCategory::Timeout), "timeout");
        assert_eq!(
            category_to_string(AiErrorCategory::ServerError),
            "server_error"
        );
        assert_eq!(
            category_to_string(AiErrorCategory::NotInstalled),
            "not_installed"
        );
        assert_eq!(category_to_string(AiErrorCategory::Unknown), "unknown");
    }

    /// The handler's response shape must serialize/deserialize cleanly so
    /// the sidecar's `planner_tool_result` envelope (which is just opaque
    /// JSON to the Rust side, but is parsed and surfaced into the model
    /// context by the planner) sees the new fields. We can't easily
    /// exercise `handle()` without an AppHandle stub, but we can guarantee
    /// the JSON we'd return is well-formed.
    #[test]
    fn response_shape_round_trips_through_serde() {
        // Mimic the exempt path's return.
        let exempt_resp = serde_json::json!({
            "ready_for_new_tasks": true,
            "parent_milestone_id": "ms_1",
            "replan_count": 0u32,
            "exempt": true,
            "error_category": "rate_limit",
        });
        let s = serde_json::to_string(&exempt_resp).unwrap();
        let back: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back["exempt"], true);
        assert_eq!(back["error_category"], "rate_limit");
        assert_eq!(back["replan_count"], 0);

        // Mimic the counted path's return — no classified category (e.g.
        // task.result was None) is encoded as JSON null.
        let counted_resp = serde_json::json!({
            "ready_for_new_tasks": true,
            "parent_milestone_id": "ms_2",
            "replan_count": 2u32,
            "exempt": false,
            "error_category": serde_json::Value::Null,
        });
        let s = serde_json::to_string(&counted_resp).unwrap();
        let back: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back["exempt"], false);
        assert!(back["error_category"].is_null());
        assert_eq!(back["replan_count"], 2);
    }
}
