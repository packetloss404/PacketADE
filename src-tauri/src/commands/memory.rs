//! Memory-layer AI commands.
//!
//! LM4 (3C-2): the pure text-in/JSON-out turns (`summarize_session`,
//! `extract_patterns`, `summarize_flight`) run through the auxiliary LLM seam
//! ([`crate::core::aux_llm`]) under the `session-summarize` /
//! `pattern-extract` / `flight-retrospective` task classes. JSON output
//! contracts are unchanged; the fixed instructions moved to the system prompt
//! and the variable payload became the user turn.
//!
//! LM4 (3C-3): `scan_codebase_memory` has moved too. It only ever shelled out
//! to the Claude CLI so that the CLI's file tools would walk the project for
//! it, and a key-file index does not need the model to *choose* what to read —
//! the walk is deterministic. [`crate::core::aux_context`] now assembles a
//! bounded, root-confined manifest in Rust and the seam runs one turn over it,
//! so `memory.rs` no longer touches the Claude CLI at all.
//!
//! `run_claude` itself stays: `commands/github.rs` (`github_investigate_issue`)
//! and `commands/insights.rs` (`ask_agent_chat_stream`) are still on it. Those
//! two genuinely need a bounded read-only tool *loop*, which is the remaining
//! half of 3C-3.

use crate::core::aux_context;
use crate::core::aux_llm::{self, AuxRoutingState, AuxTaskClass};
use crate::core::storage;
use serde::Deserialize;
use tauri::State;
use tracing::info;

/// Fixed instructions for the codebase key-file scan. The JSON output contract
/// is byte-for-byte the pre-migration one, so any future caller sees the same
/// shape the Claude CLI produced.
const MEMORY_SCAN_SYSTEM_PROMPT: &str = r#"You are indexing a codebase. The user gives you a file manifest and short excerpts, both assembled locally from the project on disk.

Identify the most important 30-50 files and give each a one-line summary of its role.

Rules:
- Output ONLY a JSON array with no markdown formatting, like: [{"path": "src/main.ts", "summary": "App entry point"}].
- Use paths exactly as they appear in the manifest.
- Never invent a file that is not listed. If the manifest is short, return fewer entries."#;

/// Index the key files of a project.
///
/// Ordering matters: the auxiliary route is resolved **before** the filesystem
/// is touched, so a user with no configured provider gets the seam's honest
/// no-provider error and this command never reads a single file. What the walk
/// will and will not read is documented on [`crate::core::aux_context`].
#[tauri::command]
pub async fn scan_codebase_memory(
    routing: State<'_, AuxRoutingState>,
    project_path: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;

    // Resolve first: no provider => no disk access, no egress, clear error.
    let route = routing.resolve(AuxTaskClass::MemoryScan)?;

    let scan_path = project_path.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        aux_context::assemble_project_manifest(&scan_path)
    })
    .await
    .map_err(|e| format!("Codebase scan task failed: {}", e))??;

    info!(
        project_path = %project_path,
        provider = %route.provider,
        model = %route.model,
        files_listed = manifest.files.len(),
        files_seen = manifest.stats.files_seen,
        excerpts = manifest.excerpt_count(),
        symlinks_skipped = manifest.stats.symlinks_skipped,
        sensitive_skipped = manifest.stats.sensitive_skipped,
        truncated = manifest.stats.truncated,
        "Scanning codebase memory"
    );

    if manifest.files.is_empty() {
        return Err(format!(
            "No readable project files found under '{}'. Nothing was sent to a model.",
            project_path
        ));
    }

    let session_id = format!(
        "{}-{}",
        AuxTaskClass::MemoryScan.id(),
        uuid::Uuid::new_v4()
    );
    aux_llm::run_aux_oneshot(
        AuxTaskClass::MemoryScan,
        &route,
        &session_id,
        MEMORY_SCAN_SYSTEM_PROMPT.to_string(),
        manifest.render(),
    )
    .await
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
    // A memory *scope*, not a path we open: a local scope is still validated as
    // a real directory, and a remote `ssh:<serverId>:<path>` scope is accepted
    // so remote workspaces can be summarized at all.
    super::validate_memory_scope(&project_path)?;
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
    // See `summarize_session` — scope label, not a path this command opens.
    super::validate_memory_scope(&project_path)?;
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
