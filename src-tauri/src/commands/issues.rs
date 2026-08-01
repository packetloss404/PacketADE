//! v0.8.5 — Issue commands.
//!
//! Currently houses `issues_extract_from_spec`, the AI-powered spec → issue
//! drafts pipeline behind the `SpecImportModal` UI.
//!
//! ## Routing (WI-1)
//!
//! This command used to fire a one-shot `claude-oauth` sidecar session so it
//! drew on the user's Claude Pro / Max subscription. That routed subscription
//! OAuth credentials for work the user never chose a provider for, and it
//! bypassed `is_sidecar_provider` entirely. It now goes through
//! [`crate::core::aux_llm`], which resolves the configured auxiliary route
//! (Settings → AI Provider Routing) or the cheapest configured API key, and
//! fails with a clear "configure a provider" message when there is none.
//!
//! ## Why synchronous?
//!
//! The frontend's `SpecImportModal` shows a two-stage UX (paste → review),
//! so the user already accepts a blocking wait between Stage 1 and Stage 2.
//! Returning a `Vec<ExtractedIssueDraft>` directly is simpler than streaming
//! `api-agent:*` events and re-parsing them on the frontend; the
//! `SPEC_IMPORT_TIMEOUT` bounds the worst-case wait.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{info, warn};

use crate::core::aux_llm::{self, AuxRoutingState, AuxTaskClass};

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

/// Wall-clock cap on the one-shot turn. The spec import is interactive
/// (user is staring at a spinner), so we'd rather fail fast than make them
/// wait 5 minutes for a degenerate response.
const SPEC_IMPORT_TIMEOUT: Duration = Duration::from_secs(120);

/// Task class for the routing layer. Provider and model come from
/// `core::aux_llm` — there is no provider constant here any more, by design.
const SPEC_IMPORT_TASK: AuxTaskClass = AuxTaskClass::SpecImport;

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
/// a JSON array of [`ExtractedIssueDraft`] using a one-shot auxiliary LLM
/// turn (see [`crate::core::aux_llm`]).
///
/// Returns the parsed drafts directly (synchronous from the frontend's
/// point of view). The frontend's `SpecImportModal` blocks on this promise
/// to advance from Stage 1 (paste) → Stage 2 (review).
///
/// Failure modes:
/// * `spec_text` empty / oversized → `Err` returned before any model call.
/// * No configured API provider → `Err` naming the feature and pointing at
///   Settings → API Keys. There is no subscription-OAuth fallback.
/// * Provider error → `Err` with the underlying message.
/// * Timeout (`SPEC_IMPORT_TIMEOUT`) → `Err`.
/// * Empty / non-JSON response → `Err` with a truncated preview of the
///   raw response so the frontend can show a retry button with context.
///
/// `project_path` is retained for wire compatibility with `SpecImportModal`
/// and for log correlation; the extraction reads no files.
#[tauri::command]
pub async fn issues_extract_from_spec(
    routing: State<'_, AuxRoutingState>,
    spec_text: String,
    project_path: String,
) -> Result<Vec<ExtractedIssueDraft>, String> {
    let trimmed = spec_text.trim();
    if trimmed.is_empty() {
        return Err("Spec text is empty.".to_string());
    }
    super::validate_input_size(&spec_text, SPEC_TEXT_CAP_BYTES, "Spec text")?;

    // Resolve provider + model before any long-running work, and drop the
    // State borrow before the first await.
    let route = routing.resolve(SPEC_IMPORT_TASK)?;

    let system_prompt = crate::core::issue_ai_prompts::SPEC_IMPORT_SYSTEM_PROMPT.to_string();
    let user_turn = crate::core::issue_ai_prompts::spec_import_user_turn(trimmed);

    // Mint a unique session id so usage rows and logs can be correlated.
    let session_id = format!("issues-spec-import-{}", uuid::Uuid::new_v4());

    info!(
        session_id = %session_id,
        project_path = %project_path,
        provider = %route.provider,
        model = %route.model,
        spec_bytes = spec_text.len(),
        "issues_extract_from_spec: starting one-shot turn"
    );

    let wait_result = tokio::time::timeout(
        SPEC_IMPORT_TIMEOUT,
        aux_llm::run_aux_oneshot(
            SPEC_IMPORT_TASK,
            &route,
            &session_id,
            system_prompt,
            user_turn,
        ),
    )
    .await;

    let raw = match wait_result {
        Ok(Ok(text)) => text,
        Ok(Err(msg)) => return Err(format!("Spec import failed: {}", msg)),
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
