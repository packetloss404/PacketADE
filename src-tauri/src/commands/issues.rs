//! v0.8.5 — Issue commands.
//!
//! Currently houses `issues_extract_from_spec`, the AI-powered spec → issue
//! drafts pipeline behind the `SpecImportModal` UI.
//!
//! ## Why the sidecar?
//!
//! Unlike `github_ai_triage` which talks to the in-process `LlmProvider`
//! (Anthropic API key route), this command intentionally routes through the
//! `claude-oauth` sidecar so it draws from the user's Claude Pro / Max
//! subscription rather than a metered API key. It follows the standard
//! one-shot sidecar pattern: register a one-shot waiter, fire
//! `forward_start`, wait for `done`, close the session.
//!
//! ## Why synchronous?
//!
//! The frontend's `SpecImportModal` shows a two-stage UX (paste → review),
//! so the user already accepts a blocking wait between Stage 1 and Stage 2.
//! Returning a `Vec<ExtractedIssueDraft>` directly is simpler than streaming
//! `api-agent:*` events and re-parsing them on the frontend; the sidecar's
//! per-request timeout (`SPEC_IMPORT_TIMEOUT`) bounds the worst-case wait.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{info, warn};

use crate::commands::agent_sidecar::SidecarManager;

/// One issue draft as returned from the AI extraction.
///
/// Wire format matches the JSON shape the system prompt instructs the model
/// to emit. The TS binding in `src/lib/tauri.ts` mirrors this shape exactly.
///
/// All optional fields use `skip_serializing_if = "Option::is_none"` so the
/// frontend receives `undefined` rather than `null` for omitted fields,
/// which lines up with how the model is told to omit (not null) absent
/// optional fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedIssueDraft {
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(
        rename = "acceptanceCriteria",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub acceptance_criteria: Option<Vec<String>>,
    #[serde(
        rename = "suggestedEpic",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub suggested_epic: Option<String>,
}

/// Maximum raw spec text bytes accepted from the frontend. Larger payloads
/// are rejected early so the model context isn't burned on multi-MB pastes
/// that the user can split into smaller imports.
const SPEC_TEXT_CAP_BYTES: usize = 200 * 1024;

/// Wall-clock cap on the one-shot session. The spec import is interactive
/// (user is staring at a spinner), so we'd rather fail fast than make them
/// wait 5 minutes for a degenerate response.
const SPEC_IMPORT_TIMEOUT: Duration = Duration::from_secs(120);

/// Model used for spec extraction. Sonnet 4.6 is the same model the rest of
/// the OAuth-routed AI features use (`github_ai_pr_description`,
/// `github_ai_pr_review`, flight-planner summarization) — consistent
/// behavior + one model to babysit across releases.
const SPEC_IMPORT_MODEL: &str = "claude-sonnet-4-6";

/// Provider — `claude-oauth` draws from `~/.claude/.credentials.json` so
/// this command works for users without an Anthropic API key configured.
const SPEC_IMPORT_PROVIDER: &str = "claude-oauth";

/// Strip surrounding markdown ```json fences from a response. Mirrors the
/// helper in `commands::github` (kept private there); duplicated here to
/// avoid widening that module's public surface for a single call site.
fn strip_json_fences(s: &str) -> &str {
    let t = s.trim();
    let after_open = if let Some(rest) = t.strip_prefix("```json") {
        rest.trim_start_matches('\n').trim_start()
    } else if let Some(rest) = t.strip_prefix("```") {
        rest.trim_start_matches('\n').trim_start()
    } else {
        t
    };
    if let Some(end) = after_open.rfind("```") {
        after_open[..end].trim_end()
    } else {
        after_open
    }
}

/// Truncate a string to at most `max_chars` characters (NOT bytes) with an
/// ellipsis marker so the caller can tell the model the cut happened. Used
/// for the bounded debug log on parse-failure paths so a 200KB raw response
/// doesn't blow out the log file.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let kept: String = s.chars().take(max_chars).collect();
        format!("{}…", kept)
    }
}

/// `issues_extract_from_spec` — break a pasted spec / PRD / design doc into
/// a JSON array of [`ExtractedIssueDraft`] using a one-shot Claude OAuth
/// sidecar session.
///
/// Returns the parsed drafts directly (synchronous from the frontend's
/// point of view). The frontend's `SpecImportModal` blocks on this promise
/// to advance from Stage 1 (paste) → Stage 2 (review).
///
/// Failure modes:
/// * `spec_text` empty / oversized → `Err` returned before any sidecar call.
/// * `SidecarManager` not managed → `Err` (shouldn't happen in a normal
///   process; only useful for tests).
/// * Sidecar `forward_start` fails → `Err` with the underlying message.
/// * Timeout (`SPEC_IMPORT_TIMEOUT`) → `Err`; the session is closed in a
///   `finally`-style block so we don't leak it.
/// * Empty / non-JSON response → `Err` with a truncated preview of the
///   raw response so the frontend can show a retry button with context.
#[tauri::command]
pub async fn issues_extract_from_spec(
    sidecar: State<'_, Arc<SidecarManager>>,
    spec_text: String,
    project_path: String,
) -> Result<Vec<ExtractedIssueDraft>, String> {
    let trimmed = spec_text.trim();
    if trimmed.is_empty() {
        return Err("Spec text is empty.".to_string());
    }
    super::validate_input_size(&spec_text, SPEC_TEXT_CAP_BYTES, "Spec text")?;

    // Resolve the sidecar manager and drop the State borrow before we await
    // any long-running operation.
    let manager = Arc::clone(&*sidecar);

    let system_prompt = crate::core::issue_ai_prompts::SPEC_IMPORT_SYSTEM_PROMPT.to_string();
    let user_turn = crate::core::issue_ai_prompts::spec_import_user_turn(trimmed);

    // Mint a unique one-shot session id so it can't collide with any
    // existing chat / planner / PR-review session.
    let session_id = format!("issues-spec-import-{}", uuid::Uuid::new_v4());

    // Register the completion waiter BEFORE `forward_start` so we can't
    // miss early chunks.
    let receiver = manager.wait_for_oneshot(&session_id).await;

    // The sidecar's Claude Agent SDK call uses `project_path` as cwd. The
    // extraction itself doesn't read files, but the SDK insists on *some*
    // path; fall back to the data dir if the caller passed an empty
    // string.
    let resolved_project_path = if project_path.trim().is_empty() {
        crate::core::storage::data_dir()
            .to_string_lossy()
            .into_owned()
    } else {
        project_path.clone()
    };

    info!(
        session_id = %session_id,
        project_path = %resolved_project_path,
        spec_bytes = spec_text.len(),
        "issues_extract_from_spec: starting one-shot session"
    );

    let start_result = manager
        .forward_start(
            session_id.clone(),
            SPEC_IMPORT_PROVIDER.to_string(),
            SPEC_IMPORT_MODEL.to_string(),
            system_prompt,
            Vec::new(),              // allowed_tools — none
            serde_json::Value::Null, // mcp_servers — none
            false,                   // source_mcp_from_fs — local session
            resolved_project_path,
            user_turn,               // initial_message carries the work
            None,                    // api_key — claude-oauth uses ~/.claude
            None,                    // resume token
            Some(false),             // thinking_enabled
            Some(false),             // plan_mode
            serde_json::Value::Null, // attachments
            serde_json::Value::Null, // resume_messages
            None,                    // permission_mode
            None,                    // approve_writes
            None,                    // command_path
            None,                    // workspace — derive local from project_path
        )
        .await;

    if let Err(e) = start_result {
        return Err(format!("Failed to start spec-import session: {}", e));
    }

    // Await completion with a wall-clock timeout. The waiter is resolved
    // by the chunk/done/error branches in `agent_sidecar::handle_event`.
    let wait_result = tokio::time::timeout(SPEC_IMPORT_TIMEOUT, receiver).await;

    // Always best-effort close the session so the supervisor's owned-set
    // doesn't leak a stale id. Mirrors the standard one-shot sidecar pattern.
    if let Err(e) = manager.forward_close(session_id.clone()).await {
        warn!(
            session_id = %session_id,
            error = %e,
            "issues_extract_from_spec: forward_close failed (non-fatal)"
        );
    }

    let raw = match wait_result {
        Ok(Ok(Ok(text))) => text,
        Ok(Ok(Err(msg))) => return Err(format!("Spec import session error: {}", msg)),
        Ok(Err(_)) => return Err("Spec import waiter dropped before completion.".to_string()),
        Err(_) => {
            return Err(format!(
                "Spec import timed out after {}s.",
                SPEC_IMPORT_TIMEOUT.as_secs()
            ))
        }
    };

    if raw.trim().is_empty() {
        return Err("The model returned an empty response.".to_string());
    }

    let stripped = strip_json_fences(&raw);

    let drafts: Vec<ExtractedIssueDraft> = serde_json::from_str(stripped).map_err(|e| {
        warn!(
            session_id = %session_id,
            error = %e,
            preview = %truncate_chars(stripped, 500),
            "issues_extract_from_spec: JSON parse failed"
        );
        format!(
            "Spec response was not valid JSON ({}). Raw preview: {}",
            e,
            truncate_chars(stripped, 500)
        )
    })?;

    info!(
        session_id = %session_id,
        draft_count = drafts.len(),
        "issues_extract_from_spec: done"
    );

    Ok(drafts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_json_fences_handles_json_tagged_fence() {
        let input = "```json\n[{\"title\":\"x\"}]\n```";
        assert_eq!(strip_json_fences(input), "[{\"title\":\"x\"}]");
    }

    #[test]
    fn strip_json_fences_handles_plain_fence() {
        let input = "```\n[{\"title\":\"x\"}]\n```";
        assert_eq!(strip_json_fences(input), "[{\"title\":\"x\"}]");
    }

    #[test]
    fn strip_json_fences_handles_unfenced_input() {
        let input = "[{\"title\":\"x\"}]";
        assert_eq!(strip_json_fences(input), "[{\"title\":\"x\"}]");
    }

    #[test]
    fn strip_json_fences_trims_surrounding_whitespace() {
        let input = "   \n```json\n[]\n```\n  ";
        assert_eq!(strip_json_fences(input), "[]");
    }

    #[test]
    fn extracted_issue_draft_round_trips_minimal_shape() {
        // Model is allowed to omit every optional field — pin the
        // deserialization contract so we don't accidentally make
        // `labels` / `acceptanceCriteria` / `suggestedEpic` required.
        let raw = r#"[{"title":"Add login","body":"Build the login screen."}]"#;
        let drafts: Vec<ExtractedIssueDraft> =
            serde_json::from_str(raw).expect("minimal shape must parse");
        assert_eq!(drafts.len(), 1);
        let d = &drafts[0];
        assert_eq!(d.title, "Add login");
        assert_eq!(d.body, "Build the login screen.");
        assert!(d.labels.is_none());
        assert!(d.acceptance_criteria.is_none());
        assert!(d.suggested_epic.is_none());
    }

    #[test]
    fn extracted_issue_draft_round_trips_full_shape() {
        let raw = r#"[{
            "title":"Add login",
            "body":"Build the login screen.",
            "labels":["frontend","auth"],
            "acceptanceCriteria":["User can log in","Failed login shows error"],
            "suggestedEpic":"Auth"
        }]"#;
        let drafts: Vec<ExtractedIssueDraft> =
            serde_json::from_str(raw).expect("full shape must parse");
        assert_eq!(drafts.len(), 1);
        let d = &drafts[0];
        assert_eq!(d.title, "Add login");
        assert_eq!(
            d.labels.as_deref(),
            Some(&["frontend".to_string(), "auth".to_string()][..])
        );
        assert_eq!(
            d.acceptance_criteria.as_deref(),
            Some(
                &[
                    "User can log in".to_string(),
                    "Failed login shows error".to_string()
                ][..]
            )
        );
        assert_eq!(d.suggested_epic.as_deref(), Some("Auth"));
    }

    #[test]
    fn extracted_issue_draft_serializes_with_camel_case_fields() {
        // The TS binding consumes the field names verbatim — pin the
        // rename attributes so a stray `snake_case` doesn't slip in.
        let draft = ExtractedIssueDraft {
            title: "t".to_string(),
            body: "b".to_string(),
            labels: None,
            acceptance_criteria: Some(vec!["ac1".to_string()]),
            suggested_epic: Some("E".to_string()),
        };
        let json = serde_json::to_string(&draft).expect("serialize");
        assert!(json.contains("\"acceptanceCriteria\":[\"ac1\"]"));
        assert!(json.contains("\"suggestedEpic\":\"E\""));
        // `labels: None` must be omitted entirely (skip_serializing_if).
        assert!(!json.contains("labels"));
    }

    #[test]
    fn truncate_chars_keeps_short_input_unchanged() {
        assert_eq!(truncate_chars("hello", 100), "hello");
    }

    #[test]
    fn truncate_chars_appends_ellipsis_when_cut() {
        let out = truncate_chars("abcdefghij", 4);
        assert_eq!(out, "abcd…");
    }
}
