use crate::claude::binary::run_claude;

#[tauri::command]
pub async fn parse_spec_to_flight(spec_text: String) -> Result<String, String> {
    super::validate_input_size(&spec_text, super::MAX_INPUT_SIZE, "Spec text")?;
    let prompt = format!(
        r#"You are a senior technical project manager. Parse the following project spec into a structured flight plan as a JSON object.

A "flight" is a top-level work unit with sequential milestones. Each milestone contains parallel or dependent tasks.

Output a single JSON object with this exact schema:
{{
  "title": "string — concise project title",
  "objective": "string — 1-2 sentence goal statement",
  "priority": "low" | "medium" | "high" | "critical",
  "milestones": [
    {{
      "title": "string — phase name",
      "description": "string — what this phase achieves",
      "validationCriteria": ["string — testable condition that proves this milestone is complete"],
      "tasks": [
        {{
          "title": "string — concise task title",
          "description": "string — what to implement or do",
          "type": "implementation" | "testing" | "review" | "validation" | "research" | "refactor" | "documentation",
          "dependsOn": ["string — positional ref like 'm0-t0' meaning milestone 0 task 0, or empty array"]
        }}
      ]
    }}
  ]
}}

Rules:
- Group related work into 2-5 milestones in logical execution order
- Each milestone should have 2-8 tasks
- Tasks within a milestone can depend on earlier tasks in the SAME milestone using "m{{milestoneIdx}}-t{{taskIdx}}" notation
- Cross-milestone dependencies are NOT allowed (milestones are sequential gates)
- Every milestone must have at least one "testing" or "validation" task
- First milestone should handle setup/foundation work
- Last milestone should include integration testing and documentation
- Use "implementation" for building features, "testing" for tests, "review" for code review, "validation" for acceptance checks, "research" for investigation, "refactor" for cleanup, "documentation" for docs

Output ONLY the JSON object, no markdown fences, no explanation.

PROJECT SPEC:
{}"#,
        spec_text
    );

    run_claude(&prompt, None).await
}

#[tauri::command]
pub async fn parse_spec_to_tickets(spec_text: String) -> Result<String, String> {
    super::validate_input_size(&spec_text, super::MAX_INPUT_SIZE, "Spec text")?;
    let prompt = format!(
        r#"You are a project manager. Parse the following project spec into a JSON array of tickets.
Each ticket must have exactly these fields:
- "title": string (concise task title)
- "description": string (detailed description of what to implement)
- "priority": one of "low", "medium", "high", "critical"
- "labels": array of strings (relevant tags like "frontend", "backend", "api", "bug", "feature", etc.)
- "acceptanceCriteria": array of strings (testable conditions for completion)

Output ONLY the JSON array, no markdown fences, no explanation.

PROJECT SPEC:
{}
"#,
        spec_text
    );

    run_claude(&prompt, None).await
}
