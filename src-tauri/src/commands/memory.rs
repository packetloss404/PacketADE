use crate::claude::binary::run_claude;
use serde::Deserialize;
use tracing::info;

#[tauri::command]
pub async fn scan_codebase_memory(project_path: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    info!(project_path = %project_path, "Scanning codebase memory");
    let prompt = r#"List the key files in this project with 1-line summaries. Output ONLY a JSON array with no markdown formatting, like: [{"path": "src/main.ts", "summary": "App entry point"}]. Include the most important 30-50 files."#;
    run_claude(prompt, Some(&project_path)).await
}

#[tauri::command]
pub async fn summarize_session(
    project_path: String,
    session_log: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    super::validate_input_size(&session_log, super::MAX_INPUT_SIZE, "Session log")?;
    let prompt = format!(
        r#"Summarize this coding session. Output ONLY a JSON object with no markdown formatting, like: {{"summary": "...", "keyDecisions": ["..."], "filesModified": ["..."]}}.

Session log:
{}"#,
        session_log
    );
    run_claude(&prompt, Some(&project_path)).await
}

#[tauri::command]
pub async fn extract_patterns(project_path: String, summaries: String) -> Result<String, String> {
    super::validate_project_path(&project_path)?;
    super::validate_input_size(&summaries, super::MAX_INPUT_SIZE, "Summaries")?;
    let prompt = format!(
        r#"Given these session summaries, extract recurring patterns about the codebase. Output ONLY a JSON array with no markdown formatting, like: [{{"pattern": "Uses Zustand for state management", "category": "architecture", "confidence": 0.9}}].
Categories: architecture, convention, preference, pitfall.

Session summaries:
{}"#,
        summaries
    );
    run_claude(&prompt, Some(&project_path)).await
}

// === Flight Retrospectives (self-improving feedback loop) ===

#[derive(Deserialize)]
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

    let prompt = format!(
        r#"Analyze this completed flight and generate a retrospective. Output ONLY a JSON object with no markdown formatting.

Flight details:
{flight_json}

Session activity:
{session_logs}

Output format:
{{
  "summary": "1-2 sentence summary of what the flight accomplished",
  "whatWorked": ["pattern or approach that was effective"],
  "whatFailed": ["issue or approach that caused problems"],
  "lessonsLearned": ["actionable insight to apply to future flights"],
  "suggestedImprovements": ["specific process improvement"],
  "tags": ["relevant topic tags for searchability"]
}}"#,
        flight_json = flight_json,
        session_logs = session_logs,
    );

    run_claude(&prompt, Some(&project_path)).await
}
