use crate::claude::binary::claude_command;
use serde::Deserialize;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

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
}

fn build_flight_chat_prompt(
    messages: &[FlightChatMessage],
    flight_state: &FlightState,
) -> String {
    let mut conversation = String::new();
    for msg in messages {
        let prefix = if msg.role == "user" { "User" } else { "Assistant" };
        conversation.push_str(&format!("{}: {}\n\n", prefix, msg.content));
    }

    // Escape braces in user-controlled fields to prevent format string issues,
    // and use JSON embedding to avoid prompt structure breakout.
    let state_json = serde_json::json!({
        "title": flight_state.title,
        "objective": flight_state.objective,
        "priority": flight_state.priority,
    });

    format!(
        r#"You are a flight planning assistant. A "flight" is a structured work unit for a coding project — it has a title, objective, and priority.

Help the user define and refine their flight. Ask clarifying questions, suggest improvements, and help them articulate their goals clearly.

When you have a concrete suggestion for the flight fields, include a fenced JSON block tagged with `json:flight` containing any fields you want to suggest. Only include fields you are changing. Example:

```json:flight
{{"title": "Refactor auth middleware", "objective": "Replace legacy session-token storage with JWT to meet compliance requirements", "priority": "high"}}
```

Valid priority values: "low", "medium", "high", "critical".

Current flight state (as JSON):
{state_json}

Conversation so far:
{conversation}
Provide a helpful response to the user's latest message."#,
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
    let prompt = build_flight_chat_prompt(&messages, &flight_state);
    super::validate_input_size(&prompt, super::MAX_INPUT_SIZE, "Flight chat prompt")?;

    let mut cmd = claude_command()?;
    cmd.args(&["-p", &prompt, "--output-format", "text"]);
    cmd.current_dir(&project_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null()); // Don't pipe stderr to avoid buffer deadlock

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude CLI: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let handle = app_handle.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Err(e) = handle.emit("flight-chat:chunk", &line) {
                warn!("Failed to emit flight-chat:chunk: {}", e);
                break;
            }
        }

        let status = child.wait().await;
        let success = status.map(|s| s.success()).unwrap_or(false);
        if let Err(e) = handle.emit("flight-chat:done", success) {
            warn!("Failed to emit flight-chat:done: {}", e);
        }
    });

    Ok(())
}
