//! Memory-layer AI commands.
//!
//! LM4 (3C-2): the pure text-in/JSON-out turns (`summarize_session`,
//! `extract_patterns`, `summarize_flight`) run through the auxiliary LLM seam
//! ([`crate::core::aux_llm`]) under the `session-summarize` /
//! `pattern-extract` / `flight-retrospective` task classes. JSON output
//! contracts are unchanged; the fixed instructions moved to the system prompt
//! and the variable payload became the user turn.
//!
//! `scan_codebase_memory` deliberately STAYS on the Claude CLI: it depends on
//! the CLI's file tools to walk the project tree (3C-3, deferred). It gets a
//! seam-side context-assembly design before it moves — see backlog.md.

use crate::claude::binary::run_claude;
use crate::core::aux_llm::{self, AuxRoutingState, AuxTaskClass};
use crate::core::storage;
use serde::Deserialize;
use tauri::State;
use tracing::info;

#[tauri::command]
pub async fn scan_codebase_memory(project_path: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    info!(project_path = %project_path, "Scanning codebase memory");
    let prompt = r#"List the key files in this project with 1-line summaries. Output ONLY a JSON array with no markdown formatting, like: [{"path": "src/main.ts", "summary": "App entry point"}]. Include the most important 30-50 files."#;
    run_claude(prompt, Some(&project_path)).await
}

async fn run_memory_turn(
    routing: State<'_, AuxRoutingState>,
    task: AuxTaskClass,
    system_prompt: String,
    user_turn: String,
) -> Result<String, String> {
    let route = routing.resolve(task)?;
    let session_id = format!("{}-{}", task.id(), uuid::Uuid::new_v4());
    info!(
        session_id = %session_id,
        provider = %route.provider,
        model = %route.model,
        "memory: one-shot aux turn"
    );
    aux_llm::run_aux_oneshot(task, &route, &session_id, system_prompt, user_turn).await
}

#[tauri::command]
pub async fn summarize_session(
    routing: State<'_, AuxRoutingState>,
    project_path: String,
    session_log: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    super::validate_input_size(&session_log, super::MAX_INPUT_SIZE, "Session log")?;
    run_memory_turn(
        routing,
        AuxTaskClass::SessionSummarize,
        r#"Summarize the coding session the user provides. Output ONLY a JSON object with no markdown formatting, like: {"summary": "...", "keyDecisions": ["..."], "filesModified": ["..."]}."#
            .to_string(),
        format!("Session log:\n{}", session_log),
    )
    .await
}

#[tauri::command]
pub async fn extract_patterns(
    routing: State<'_, AuxRoutingState>,
    project_path: String,
    summaries: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    super::validate_input_size(&summaries, super::MAX_INPUT_SIZE, "Summaries")?;
    run_memory_turn(
        routing,
        AuxTaskClass::PatternExtract,
        r#"Given the session summaries the user provides, extract recurring patterns about the codebase. Output ONLY a JSON array with no markdown formatting, like: [{"pattern": "Uses Zustand for state management", "category": "architecture", "confidence": 0.9}].
Categories: architecture, convention, preference, pitfall."#
            .to_string(),
        format!("Session summaries:\n{}", summaries),
    )
    .await
}

// === Flight Retrospectives (self-improving feedback loop) ===

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightSummaryInput {
    pub title: String,
    pub objective: String,
    pub priority: String,
    pub status: String,
    pub task_count: usize,
    pub tasks_done: usize,
    pub tasks_failed: usize,
    pub duration_description: String,
}

/// Generate a retrospective for a completed flight. The retrospective captures
/// what worked, what failed, and patterns to carry forward — inspired by
/// Hermes Agent's self-improving skill/memory loop.
#[tauri::command]
pub async fn summarize_flight(
    routing: State<'_, AuxRoutingState>,
    project_path: String,
    flight_summary: FlightSummaryInput,
    session_logs: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    super::validate_input_size(&session_logs, super::MAX_INPUT_SIZE, "Session logs")?;

    let flight_json = serde_json::json!({
        "title": flight_summary.title,
        "objective": flight_summary.objective,
        "priority": flight_summary.priority,
        "status": flight_summary.status,
        "taskCount": flight_summary.task_count,
        "tasksDone": flight_summary.tasks_done,
        "tasksFailed": flight_summary.tasks_failed,
        "duration": flight_summary.duration_description,
    });

    let system_prompt = r#"Analyze the completed flight the user provides and generate a retrospective. Output ONLY a JSON object with no markdown formatting.

Output format:
{
  "summary": "1-2 sentence summary of what the flight accomplished",
  "whatWorked": ["pattern or approach that was effective"],
  "whatFailed": ["issue or approach that caused problems"],
  "lessonsLearned": ["actionable insight to apply to future flights"],
  "suggestedImprovements": ["specific process improvement"],
  "tags": ["relevant topic tags for searchability"]
}"#
        .to_string();

    let user_turn = format!(
        "Flight details:\n{flight_json}\n\nSession activity:\n{session_logs}",
        flight_json = flight_json,
        session_logs = session_logs,
    );

    run_memory_turn(
        routing,
        AuxTaskClass::FlightRetrospective,
        system_prompt,
        user_turn,
    )
    .await
}

// === v0.8-H: memory inline surfaces — atomic pin/unpin endpoint ===

/// Toggle the `pinned` flag on a single learned pattern. Returns the new
/// pinned state, or `None` if no pattern with that id exists. The frontend
/// store also tracks its own `pinned` state in-memory for snappy UI; this
/// command keeps the persisted record authoritative across restarts.
#[tauri::command]
pub async fn toggle_pinned_pattern(pattern_id: String) -> Result<Option<bool>, String> {
    info!(pattern_id = %pattern_id, "Toggling pinned flag on pattern");
    storage::toggle_pinned_pattern(&pattern_id).await
}
