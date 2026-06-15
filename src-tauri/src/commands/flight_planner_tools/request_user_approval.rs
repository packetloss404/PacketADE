//! `request_user_approval` tool handler.
//!
//! Owned by **E2-APPR-STATE**.
//!
//! Args shape:
//! ```json
//! { "question": string, "options"?: string[] }
//! ```
//!
//! Per the locked design this tool is **async-return**: the planner
//! must NOT block waiting for the user. The handler files a
//! `FlightApprovalRequest` onto `PersistedState::flight_approvals`,
//! emits a UI event so the approval surface lights up, and returns a
//! sentinel right away. The planner's system prompt teaches it that
//! `pending_approval:<id>` means "filed, keep working" — the actual
//! user response is delivered later via the
//! `WakeTrigger::UserMessageInJournal` path triggered by
//! `resolve_flight_approval` (see `flight_planner.rs`).
//!
//! Implementation note: the state mutation runs under the async
//! `core::storage::with_state_lock` helper so concurrent planner-tool
//! handlers (firing in parallel within a single planner turn) can't lose
//! each other's writes. The owning flight is resolved through the
//! `FlightPlannerRegistry` reverse-lookup keyed off the sidecar
//! `session_id`.
//!
//! Returns:
//! ```json
//! { "status": "pending_approval", "approval_id": string }
//! ```

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

use crate::commands::flight_planner::{
    flight_id_for_persisted_planner_session, FlightPlannerRegistry,
};
use crate::core::flight::FlightApprovalRequest;
use crate::core::storage;

// Matches the sidecar zod schema's caps (see `agent-sidecar/src/mcp/...`):
//   * question: non-empty, ≤ 500 chars
//   * options: optional, ≤ 6 entries
const MAX_QUESTION_LEN: usize = 500;
const MAX_OPTIONS: usize = 6;

#[derive(Debug, Deserialize)]
struct RequestUserApprovalArgs {
    question: String,
    #[serde(default)]
    options: Option<Vec<String>>,
}

pub async fn handle(
    app: &AppHandle,
    session_id: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 1. Parse + validate args.
    let parsed: RequestUserApprovalArgs =
        serde_json::from_value(args).map_err(|e| format!("invalid args: {}", e))?;

    let question = parsed.question.trim();
    if question.is_empty() {
        return Err("invalid args: question must be non-empty".to_string());
    }
    if question.chars().count() > MAX_QUESTION_LEN {
        return Err(format!(
            "invalid args: question must be ≤ {} chars",
            MAX_QUESTION_LEN
        ));
    }
    let options = parsed.options.unwrap_or_default();
    if options.len() > MAX_OPTIONS {
        return Err(format!(
            "invalid args: options must be ≤ {} entries",
            MAX_OPTIONS
        ));
    }

    // 2. Resolve flight_id from session_id via the registry reverse-lookup
    //    (see `update_task.rs` for the reference pattern).
    let flight_id = resolve_flight_id_for_sidecar_session(app, session_id).await?;

    // 3. Build the new approval request.
    let approval_id = format!("appr_{}", uuid::Uuid::new_v4());
    let approval = FlightApprovalRequest {
        id: approval_id.clone(),
        flight_id: flight_id.clone(),
        question: question.to_string(),
        options,
        awaiting_since: now_millis(),
        resolved: false,
        resolution: None,
        resolved_at: None,
    };

    // 4. Append to PersistedState.flight_approvals under the async state
    //    lock. The mutation runs synchronously inside the closure body
    //    and we return an async block independent of `state`'s borrow —
    //    this sidesteps a Rust lifetime inference limitation with
    //    `FnOnce(&mut _) -> impl Future` (Rust can't yet infer that the
    //    returned Future may only outlive the `&mut` borrow). The closure
    //    returns the approval clone so we can emit the UI event AFTER the
    //    lock is released — Tauri emits must not run while the mutex is
    //    held.
    let approval_for_closure = approval.clone();
    let emitted_approval = storage::with_state_lock(move |state| {
        let approval = approval_for_closure;
        state.flight_approvals.push(approval.clone());
        async move { Ok::<_, String>(approval) }
    })
    .await
    .map_err(|e| format!("failed to persist flight approval: {}", e))?;

    // 5. Emit the UI event the frontend's flightPlannerStore is listening
    //    for. Event name MUST match `flightPlannerApprovalRequestEvent` in
    //    `src/lib/events.ts` exactly.
    let event_name = format!("flight-planner:approval-request:{}", flight_id);
    if let Err(e) = app.emit(&event_name, &emitted_approval) {
        warn!(
            error = %e,
            event = %event_name,
            "failed to emit flight planner approval request event"
        );
    }

    // 6. Coordination event: there is no `CoordinationEvent` enum in the
    //    repo today (see report) — skipped intentionally. The wake bus
    //    isn't fired here either: by D1 design, the planner stays awake on
    //    its current turn and the user resolves the approval later, which
    //    emits a `WakeTrigger::UserMessageInJournal` via
    //    `resolve_flight_approval`.

    // E7-HOOKS site 5 — also append a dedicated `ApprovalRequest` journal
    // entry so the UI can render the request interactively (the matching
    // ToolCall entry the dispatcher writes is rendered as a generic tool
    // invocation). The two entries reference the same approval_id; the UI
    // is free to dedupe by id if it prefers.
    let options_text = if emitted_approval.options.is_empty() {
        "(free text)".to_string()
    } else {
        emitted_approval.options.join(", ")
    };
    let body = format!(
        "**question**: {}\n**options**: {}",
        emitted_approval.question, options_text
    );
    let metadata = serde_json::json!({
        "approvalId": approval_id,
        "question": emitted_approval.question,
        "options": emitted_approval.options,
    });
    let entry = crate::commands::flight_planner::journal_entry(
        flight_id.clone(),
        crate::core::flight_journal::JournalKind::ApprovalRequest,
        body,
        Some(metadata),
    );
    crate::commands::flight_planner::write_journal_and_emit(app, entry).await;

    // 7. Return the async-return sentinel IMMEDIATELY.
    Ok(serde_json::json!({
        "status": "pending_approval",
        "approval_id": approval_id,
    }))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

async fn resolve_flight_id_for_sidecar_session(
    app: &AppHandle,
    session_id: &str,
) -> Result<String, String> {
    if let Some(registry) = app.try_state::<FlightPlannerRegistry>() {
        if let Some(flight_id) = registry.flight_id_for_sidecar_session(session_id).await {
            return Ok(flight_id);
        }
    }

    let state = storage::load_state();
    flight_id_for_persisted_planner_session(&state, session_id).ok_or_else(|| {
        format!(
            "no active or persisted planner session found for sidecar session '{}'",
            session_id
        )
    })
}
