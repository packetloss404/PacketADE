//! Spec parsing — spec text → structured flight plan / ticket array.
//!
//! LM4 (3C-2): these are pure text-in/JSON-out turns, so they run through the
//! auxiliary LLM seam ([`crate::core::aux_llm`]) — routed by the
//! `spec-to-flight` / `spec-to-tickets` task classes — instead of shelling
//! out to the Claude CLI via `run_claude`. The JSON output contracts are
//! unchanged; the fixed instructions moved to the system prompt and the spec
//! text became the user turn.

use tauri::State;
use tracing::info;

use crate::core::aux_llm::{self, AuxRoutingState, AuxTaskClass};

const SPEC_TO_FLIGHT_SYSTEM_PROMPT: &str = r#"You are a senior technical project manager. Parse the project spec the user provides into a structured flight plan as a JSON object.

A "flight" is a top-level work unit with sequential milestones. Each milestone contains parallel or dependent tasks.

Output a single JSON object with this exact schema:
{
  "title": "string — concise project title",
  "objective": "string — 1-2 sentence goal statement",
  "priority": "low" | "medium" | "high" | "critical",
  "milestones": [
    {
      "title": "string — phase name",
      "description": "string — what this phase achieves",
      "validationCriteria": ["string — testable condition that proves this milestone is complete"],
      "tasks": [
        {
          "title": "string — concise task title",
          "description": "string — what to implement or do",
          "type": "implementation" | "testing" | "review" | "validation" | "research" | "refactor" | "documentation",
          "dependsOn": ["string — positional ref like 'm0-t0' meaning milestone 0 task 0, or empty array"]
        }
      ]
    }
  ]
}

Rules:
- Group related work into 2-5 milestones in logical execution order
- Each milestone should have 2-8 tasks
- Tasks within a milestone can depend on earlier tasks in the SAME milestone using "m{milestoneIdx}-t{taskIdx}" notation
- Cross-milestone dependencies are NOT allowed (milestones are sequential gates)
- Every milestone must have at least one "testing" or "validation" task
- First milestone should handle setup/foundation work
- Last milestone should include integration testing and documentation
- Use "implementation" for building features, "testing" for tests, "review" for code review, "validation" for acceptance checks, "research" for investigation, "refactor" for cleanup, "documentation" for docs

Output ONLY the JSON object, no markdown fences, no explanation."#;

const SPEC_TO_TICKETS_SYSTEM_PROMPT: &str = r#"You are a project manager. Parse the project spec the user provides into a JSON array of tickets.
Each ticket must have exactly these fields:
- "title": string (concise task title)
- "description": string (detailed description of what to implement)
- "priority": one of "low", "medium", "high", "critical"
- "labels": array of strings (relevant tags like "frontend", "backend", "api", "bug", "feature", etc.)
- "acceptanceCriteria": array of strings (testable conditions for completion)

Output ONLY the JSON array, no markdown fences, no explanation."#;

async fn run_spec_turn(
    routing: State<'_, AuxRoutingState>,
    task: AuxTaskClass,
    system_prompt: &str,
    spec_text: &str,
) -> Result<String, String> {
    let route = routing.resolve(task)?;
    let session_id = format!("{}-{}", task.id(), uuid::Uuid::new_v4());
    info!(
        session_id = %session_id,
        provider = %route.provider,
        model = %route.model,
        spec_bytes = spec_text.len(),
        "spec: one-shot aux turn"
    );
    aux_llm::run_aux_oneshot(
        task,
        &route,
        &session_id,
        system_prompt.to_string(),
        format!("PROJECT SPEC:\n{}", spec_text),
    )
    .await
}

#[tauri::command]
pub async fn parse_spec_to_flight(
    routing: State<'_, AuxRoutingState>,
    spec_text: String,
) -> Result<String, String> {
    super::validate_input_size(&spec_text, super::MAX_INPUT_SIZE, "Spec text")?;
    run_spec_turn(
        routing,
        AuxTaskClass::SpecToFlight,
        SPEC_TO_FLIGHT_SYSTEM_PROMPT,
        &spec_text,
    )
    .await
}

#[tauri::command]
pub async fn parse_spec_to_tickets(
    routing: State<'_, AuxRoutingState>,
    spec_text: String,
) -> Result<String, String> {
    super::validate_input_size(&spec_text, super::MAX_INPUT_SIZE, "Spec text")?;
    run_spec_turn(
        routing,
        AuxTaskClass::SpecToTickets,
        SPEC_TO_TICKETS_SYSTEM_PROMPT,
        &spec_text,
    )
    .await
}
