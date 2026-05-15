//! Mission Planner — system prompt + wake-message builders.
//!
//! This module is the single home for hand-authored prompt content that the
//! planner agent sees. It's intentionally split out from
//! `commands::mission_planner` so prompt iteration doesn't churn the planner
//! supervisor / registry code.
//!
//! Status: **E1 skeleton.** [`spec_mode_system_prompt`] returns a placeholder
//! and the per-wake-trigger sections of [`wake_user_message`] inline the
//! trigger payload verbatim. The real content lands in **E4** (initial
//! decomposition system prompt) and **E5** (reactive replan prompts).
//!
//! Wake-trigger envelope ownership: **the sidecar is the wrap authority.**
//! `wake_user_message` returns ONLY the body content (trigger payload,
//! journal tail, mission snapshot). The sidecar's `injectUserTurn` handler
//! in `agent-sidecar/src/providers/anthropic.ts` wraps that body in
//! `<wake_trigger source="wake_trigger" kind="…">…</wake_trigger>` based on
//! the `source` / `trigger` fields of the `inject_user_turn` request, so
//! the planner system prompt can teach the model to distinguish
//! wake-triggered re-entry from a real human message. Wrapping here too
//! would double-wrap the envelope.

use serde_json::Value;

use crate::commands::mission_planner::WakeTrigger;

/// Return the system prompt the planner agent starts with in **spec mode**.
///
/// **E1 placeholder.** The full content (decomposition instructions, async
/// tool semantics for `request_user_approval`, replan guardrails, etc.) is
/// owned by E4. We ship a stub now so the E1 plumbing has something to wire
/// up end-to-end without blocking on prompt design.
pub fn spec_mode_system_prompt() -> String {
    "You are a mission planner. (E4 will populate this.)".to_string()
}

/// Build the user-message body for a wake-triggered planner turn.
///
/// Returns **only the body** (trigger payload, journal tail, mission
/// snapshot) — NOT the `<wake_trigger>` envelope. The sidecar's
/// `injectUserTurn` handler owns the wrapper and is the single authority
/// on its shape; wrapping here would double-wrap the envelope.
///
/// Per-kind content sections are **E1 stubs**: trigger kind + payload JSON
/// inline. E4/E5 will replace each section with hand-authored guidance
/// (what the planner should consider, which tools to prefer, etc.) without
/// changing the body shape.
///
/// `journal_tail` is the recent journal slice the planner should be aware
/// of for this wake. `mission_snapshot` is a structured view of the mission
/// (milestones, task statuses, attempt outcomes) — included verbatim as
/// JSON for now; E4/E5 will pick targeted fields.
pub fn wake_user_message(
    trigger: &WakeTrigger,
    journal_tail: &str,
    mission_snapshot: &Value,
) -> String {
    let kind = trigger.kind_str();
    let payload = trigger_payload_json(trigger);
    let payload_str = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());

    // E1 stub: just dump the trigger payload + journal tail + snapshot. The
    // sidecar wraps this in <wake_trigger> before pushing onto the SDK's
    // prompt iterable; the inner content is malleable.
    let snapshot_str =
        serde_json::to_string_pretty(mission_snapshot).unwrap_or_else(|_| "{}".to_string());

    format!(
        "Trigger: {kind}\n\nPayload:\n{payload_str}\n\nJournal tail:\n{journal_tail}\n\nMission snapshot:\n{snapshot_str}"
    )
}

/// Render a [`WakeTrigger`] as a JSON payload for inclusion in the
/// wake-message body. Kept local because the wake-message format is
/// prompt-side concern, not protocol-side.
fn trigger_payload_json(trigger: &WakeTrigger) -> Value {
    match trigger {
        WakeTrigger::Decomposition => serde_json::json!({}),
        WakeTrigger::TaskCompleted(task_id) => serde_json::json!({ "taskId": task_id }),
        WakeTrigger::TaskFailed(task_id) => serde_json::json!({ "taskId": task_id }),
        WakeTrigger::ApprovalGateReached(task_id) => serde_json::json!({ "taskId": task_id }),
        WakeTrigger::CollisionDetected(task_ids) => serde_json::json!({ "taskIds": task_ids }),
        WakeTrigger::UserMessageInJournal(message) => serde_json::json!({ "message": message }),
        WakeTrigger::QuotaExhausted => serde_json::json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spec_mode_system_prompt_is_nonempty() {
        // We don't pin the wording — E4 owns that — but the function must
        // return a non-empty string so callers can pass it straight to the
        // sidecar without conditional handling.
        assert!(!spec_mode_system_prompt().is_empty());
    }

    #[test]
    fn wake_user_message_returns_unwrapped_body() {
        // The sidecar's injectUserTurn handler is the single authority on
        // the `<wake_trigger>` envelope. This builder must return only the
        // body content; wrapping here would double-wrap the envelope.
        let msg = wake_user_message(
            &WakeTrigger::TaskCompleted("task-42".to_string()),
            "(journal)",
            &json!({}),
        );
        assert!(!msg.contains("<wake_trigger"));
        assert!(!msg.contains("</wake_trigger>"));
        // The body itself still surfaces the trigger kind + payload so
        // E4/E5 prompt sections can rely on those tokens being present.
        assert!(msg.contains("task_completed"));
        assert!(msg.contains("task-42"));
    }

    #[test]
    fn wake_user_message_includes_collision_task_ids() {
        let msg = wake_user_message(
            &WakeTrigger::CollisionDetected(vec!["a".to_string(), "b".to_string()]),
            "",
            &json!({}),
        );
        assert!(msg.contains("\"a\""));
        assert!(msg.contains("\"b\""));
        assert!(msg.contains("collision_detected"));
    }
}
