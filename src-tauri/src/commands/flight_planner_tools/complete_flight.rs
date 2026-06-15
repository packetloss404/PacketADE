//! `complete_flight` tool handler.
//!
//! Owned by **E2-REPL-COMP** (paired with `replan_after_failure`).
//!
//! Args shape:
//! ```json
//! { "summary": string }
//! ```
//!
//! Terminal tool: flips the owning Flight's [`FlightStatus::Done`],
//! transitions the planner session record to [`PlannerStatus::Completed`],
//! removes the planner from the live registry so subsequent wake events
//! noop, and closes the underlying sidecar session.
//!
//! Journal storage is E7's responsibility; until that lands, the supplied
//! `summary` is broadcast on the coordination event payload so the UI can
//! surface it inline.
//!
//! Returns `{ "ok": true }` on success.

use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::commands::agent_sidecar::SidecarManager;
use crate::commands::flight_planner::{FlightPlannerRegistry, PlannerStatus};
use crate::core::flight::FlightStatus;
use crate::core::storage;

#[derive(Debug, Deserialize)]
struct CompleteFlightArgs {
    #[serde(default)]
    summary: String,
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Parse args.
    let parsed: CompleteFlightArgs =
        serde_json::from_value(args).map_err(|e| format!("invalid args: {}", e))?;
    let summary = parsed.summary;

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

    // Shutdown order (per E2 peer-review fix): close → remove → save → emit.
    // The old order (remove → save → close) could leave the sidecar
    // conversation alive if forward_close failed after we'd already torn the
    // registry entry down. By looking up the sidecar_session_id first and
    // closing the sidecar BEFORE registry removal, a forward_close error
    // doesn't strand state.

    // 3. Look up the sidecar_session_id BEFORE removing the registry entry.
    let sidecar_session_id = {
        let session = registry.get_by_flight(&flight_id).await.ok_or_else(|| {
            format!(
                "complete_flight: planner session for flight '{}' not found in registry",
                flight_id
            )
        })?;
        session.sidecar_session_id.clone()
    };

    // 4. Close sidecar first (best-effort — log on failure but continue so
    //    we still clean up the registry + flight state).
    if let Some(sidecar) = app.try_state::<Arc<SidecarManager>>() {
        if let Err(e) = sidecar.forward_close(sidecar_session_id.clone()).await {
            warn!(
                error = %e,
                sidecar_session_id = %sidecar_session_id,
                "complete_flight: forward_close failed; continuing with registry + state cleanup"
            );
        }
    } else {
        warn!("complete_flight: SidecarManager not managed; skipping forward_close");
    }

    // 5. E10 FIX P0 — unlisten the compaction-trigger event handler BEFORE
    //    removing the session from the registry. The EventId was captured
    //    in `start_flight_planner` and stored on the session record;
    //    without unlistening here, every planner that ends via
    //    `complete_flight` would leak its compaction listener. (The
    //    leaked listener would still fire on stray events, but its
    //    `perform_compaction` body would no-op on the "planner session not
    //    found" branch — wasteful, not catastrophic. Still: clean up.)
    if let Some(event_id) = registry.take_compaction_listener(&flight_id).await {
        use tauri::Listener as _;
        app.unlisten(event_id);
        tracing::debug!(
            flight_id = %flight_id,
            event_id,
            "complete_flight: unlistened compaction-trigger"
        );
    }

    // 6. Remove from registry so the wake consumer's `get_by_flight`
    //    lookup returns None and dispatch_wake no-ops for any further wake
    //    events queued for this flight.
    //
    //    E7-PARTIAL-DRAIN: pass `Some(app)` so any in-progress streamed
    //    thought from this turn is drained and journaled as a partial
    //    `PlannerMessage` rather than being silently dropped.
    let _removed = registry.remove_session(&flight_id, Some(app)).await;

    // 7. Flip the Flight to Done + mirror planner_status onto the DTO so
    //    the frontend sees a consistent view after refresh. Both mutations
    //    go inside `with_state_lock` so a concurrent tool handler can't
    //    interleave a save between them.
    let now = now_millis();
    let flight_id_for_closure = flight_id.clone();
    let completed_planner_status = PlannerStatus::Completed.to_flight_status();
    storage::with_state_lock(move |state| {
        let flight_id = flight_id_for_closure;
        let result: Result<(), String> = (|| {
            let flight = state
                .flights
                .iter_mut()
                .find(|f| f.id == flight_id)
                .ok_or_else(|| format!("flight not found for flight '{}'", flight_id))?;
            flight.status = FlightStatus::Done;
            flight.completed_at = Some(now);
            flight.updated_at = now;
            // Mirror the planner status onto the Flight DTO + clear the
            // session id, matching what `persist_planner_state_on_flight`
            // would have done — inlined here so the whole transition is
            // one atomic save.
            flight.planner_session_id = None;
            flight.planner_status = Some(completed_planner_status);
            Ok(())
        })();
        std::future::ready(result)
    })
    .await
    .map_err(|e| format!("failed to persist flight completion: {}", e))?;

    // 8. Coordination event (outside lock). E7 will hang the summary on the
    //    persisted journal; for now the payload is the journal entry.
    info!(
        flight_id = %flight_id,
        summary_len = summary.len(),
        "flight planner completed flight"
    );
    let event_name = format!("flight-planner:flight-completed:{}", flight_id);
    if let Err(e) = app.emit(
        &event_name,
        serde_json::json!({
            "flightId": flight_id,
            "summary": summary,
            "completedAt": now,
        }),
    ) {
        warn!(error = %e, event = %event_name, "failed to emit flight-completed event");
    }

    Ok(serde_json::json!({ "ok": true }))
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
    fn deserializes_with_summary() {
        let v = serde_json::json!({ "summary": "All milestones green." });
        let parsed: CompleteFlightArgs = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.summary, "All milestones green.");
    }

    #[test]
    fn deserializes_with_empty_summary() {
        let v = serde_json::json!({});
        let parsed: CompleteFlightArgs = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.summary, "");
    }
}
