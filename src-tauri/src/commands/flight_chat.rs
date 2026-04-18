use crate::claude::binary::claude_command;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

fn flight_chat_chunk_event(request_id: &str) -> String {
    format!("flight-chat:chunk:{}", request_id)
}

fn flight_chat_error_event(request_id: &str) -> String {
    format!("flight-chat:error:{}", request_id)
}

fn flight_chat_done_event(request_id: &str) -> String {
    format!("flight-chat:done:{}", request_id)
}

#[derive(Clone, Serialize)]
struct StreamError {
    category: String,
    message: String,
    suggestion: String,
    is_transient: bool,
}

#[derive(Deserialize)]
pub struct FlightChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct FlightState {
    pub title: String,
    pub objective: String,
    pub priority: String,
    #[serde(default)]
    pub milestones: Vec<FlightStateMilestone>,
}

#[derive(Deserialize)]
pub struct FlightStateMilestone {
    pub title: String,
    #[serde(default)]
    pub tasks: Vec<FlightStateTask>,
}

#[derive(Deserialize)]
pub struct FlightStateTask {
    pub title: String,
    #[serde(rename = "type")]
    pub task_type: String,
}

fn build_flight_chat_prompt(
    messages: &[FlightChatMessage],
    flight_state: &FlightState,
    retrospectives: Option<&str>,
) -> String {
    let mut conversation = String::new();
    for msg in messages {
        let prefix = if msg.role == "user" { "User" } else { "Assistant" };
        conversation.push_str(&format!("{}: {}\n\n", prefix, msg.content));
    }

    // Escape braces in user-controlled fields to prevent format string issues,
    // and use JSON embedding to avoid prompt structure breakout.
    let mut state_obj = serde_json::json!({
        "title": flight_state.title,
        "objective": flight_state.objective,
        "priority": flight_state.priority,
    });
    if !flight_state.milestones.is_empty() {
        let milestones: Vec<serde_json::Value> = flight_state
            .milestones
            .iter()
            .map(|m| {
                let tasks: Vec<serde_json::Value> = m
                    .tasks
                    .iter()
                    .map(|t| serde_json::json!({ "title": t.title, "type": t.task_type }))
                    .collect();
                serde_json::json!({ "title": m.title, "tasks": tasks })
            })
            .collect();
        state_obj["milestones"] = serde_json::Value::Array(milestones);
    }
    let state_json = state_obj;

    let retro_section = match retrospectives {
        Some(retros) if !retros.is_empty() => format!(
            "\n\nLearnings from previous flights (use these to give better advice):\n{}\n",
            retros
        ),
        _ => String::new(),
    };

    format!(
        r#"You are a flight planning assistant for PacketADE, a multi-agent development environment. A "flight" is a structured work plan for a coding project. Flights have a title, objective, priority, milestones, and tasks.

Your job is to help the user spec out their project through conversation. Take your time — ask clarifying questions, understand requirements, and help them think through edge cases before proposing a plan. Aim for 3-5 exchanges before finalizing.

## Capabilities

When you have a concrete suggestion for basic flight fields (title, objective, priority), include a fenced JSON block:

```json:flight
{{"title": "...", "objective": "...", "priority": "high"}}
```

When the spec is solid enough to break into milestones and tasks, emit a full flight plan:

```json:flight-plan
{{
  "title": "...",
  "objective": "...",
  "priority": "high",
  "milestones": [
    {{
      "title": "Core implementation",
      "description": "Build the main feature",
      "validationCriteria": ["Feature works end-to-end", "Tests pass"],
      "tasks": [
        {{
          "title": "Implement the data model",
          "description": "Create types and store logic",
          "type": "implementation",
          "dependsOn": []
        }},
        {{
          "title": "Write unit tests",
          "description": "Cover the new data model",
          "type": "testing",
          "dependsOn": ["Implement the data model"]
        }}
      ]
    }}
  ]
}}
```

## Rules

- Valid priority values: "low", "medium", "high", "critical"
- Valid task types: "implementation", "testing", "review", "validation", "research", "refactor", "documentation"
- Each task will be automatically assigned to the best AI agent (Claude Code, Codex, etc.) — you don't need to specify agents
- `dependsOn` is a list of task titles within the same milestone that must complete first
- Order milestones logically — they execute sequentially
- Tasks within a milestone can run in parallel if they don't depend on each other
- Don't emit a `json:flight-plan` block until you've had enough back-and-forth to understand the scope
- If the user's request is small (single feature, bug fix), a single milestone with 1-3 tasks is fine
- Keep task descriptions concise but specific enough for an AI agent to execute
{retro_section}
Current flight state (as JSON):
{state_json}

Conversation so far:
{conversation}
Provide a helpful response to the user's latest message."#,
        retro_section = retro_section,
        state_json = state_json,
        conversation = conversation,
    )
}

#[tauri::command]
pub async fn ask_flight_chat_stream(
    app_handle: tauri::AppHandle,
    project_path: String,
    messages: Vec<FlightChatMessage>,
    flight_state: FlightState,
    retrospectives: Option<String>,
    request_id: Option<String>,
) -> Result<(), String> {
    super::validate_project_path(&project_path)?;

    // Validate message roles
    for msg in &messages {
        if msg.role != "user" && msg.role != "assistant" {
            return Err(format!("Invalid message role: {}", msg.role));
        }
    }

    info!(
        project_path = %project_path,
        message_count = messages.len(),
        "Flight chat stream query"
    );
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let prompt = build_flight_chat_prompt(&messages, &flight_state, retrospectives.as_deref());
    super::validate_input_size(&prompt, super::MAX_INPUT_SIZE, "Flight chat prompt")?;

    let mut cmd = claude_command()?;
    cmd.args(&["-p", &prompt, "--output-format", "text"]);
    cmd.current_dir(&project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let stderr = child.stderr.take();

    let handle = app_handle.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Err(e) = handle.emit(&flight_chat_chunk_event(&request_id), &line) {
                warn!("Failed to emit flight-chat:chunk: {}", e);
                break;
            }
        }

        let stderr_text = if let Some(se) = stderr {
            let mut buf = String::new();
            let mut sr = BufReader::new(se);
            let _ = tokio::io::AsyncReadExt::read_to_string(&mut sr, &mut buf).await;
            buf
        } else {
            String::new()
        };

        let status = child.wait().await;
        let success = status.map(|s| s.success()).unwrap_or(false);

        if !success && !stderr_text.trim().is_empty() {
            let classified = super::error_classifier::classify_cli_error(&stderr_text);
            let _ = handle.emit(&flight_chat_error_event(&request_id), StreamError {
                category: format!("{:?}", classified.category).to_lowercase(),
                message: classified.message,
                suggestion: classified.suggestion,
                is_transient: classified.is_transient,
            });
        }

        if let Err(e) = handle.emit(&flight_chat_done_event(&request_id), success) {
            warn!("Failed to emit flight-chat:done: {}", e);
        }
    });

    Ok(())
}
