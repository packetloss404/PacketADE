//! Ideation Scanner backend.
//!
//! Generates a JSON array of improvement ideas for the current project
//! by sending an audit prompt to any configured `LlmProvider`. The
//! response is accumulated from text deltas and returned to the
//! frontend as a single string — the existing parser in
//! `ideationStore.ts` then handles JSON extraction.
//!
//! Previously this command shelled out to the Claude CLI via
//! `run_claude`. It now uses the same multi-provider infrastructure as
//! the API agents so it works with any provider the user has
//! configured (Anthropic / OpenAI / MiniMax / OpenRouter / Ollama).

use crate::commands::api_keys;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::{ChatMessage, ChatRole, LlmRequest, MessageContent, StreamChunk};
use tokio::sync::mpsc;
use tracing::{info, warn};

const SYSTEM_PROMPT: &str = "You are a senior software engineer performing a codebase audit. Output ONLY a JSON array — no markdown code fences, no prose explanation. Be specific and actionable.";

fn build_user_prompt(types: &str) -> String {
    format!(
        r#"Analyze the project in the working directory and generate improvement ideas for these categories: {}.

Output ONLY a JSON array. Each element must have exactly these fields:
- "type": one of "code_improvements", "security", "performance", "code_quality", "documentation", "ui_ux"
- "title": string (concise title)
- "description": string (detailed explanation of the issue or opportunity)
- "severity": one of "low", "medium", "high", "critical"
- "affectedFiles": array of file paths (relative to project root)
- "suggestion": string (specific actionable recommendation)
- "effort": one of "trivial", "small", "medium", "large"

Generate 5-15 ideas across the requested categories."#,
        types
    )
}

/// Ollama runs locally and doesn't need an API key. Other providers
/// load their key from the OS keyring.
fn load_api_key_for(provider: &str) -> Result<String, String> {
    match provider {
        "ollama" => Ok(String::new()),
        _ => api_keys::load_api_key(provider).map_err(|e| {
            format!(
                "Ideation requires an API key for '{}'. {}. Add one in Settings → API Keys.",
                provider, e
            )
        }),
    }
}

#[tauri::command]
pub async fn generate_ideas(
    project_path: String,
    idea_types: Vec<String>,
    provider: String,
    model: String,
) -> Result<String, String> {
    super::validate_project_path(&project_path)?;

    if idea_types.is_empty() {
        return Err("At least one idea type must be selected.".to_string());
    }
    if provider.trim().is_empty() {
        return Err("Provider cannot be empty.".to_string());
    }
    if model.trim().is_empty() {
        return Err("Model cannot be empty.".to_string());
    }

    info!(
        project_path = %project_path,
        provider = %provider,
        model = %model,
        types = ?idea_types,
        "Generating ideas"
    );

    let api_key = load_api_key_for(&provider)?;
    let llm = get_provider(&provider)?;

    let types_str = idea_types.join(", ");
    let user_text = build_user_prompt(&types_str);

    let request = LlmRequest {
        model,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: MessageContent::text(user_text),
        }],
        tools: Vec::new(),
        system_prompt: Some(SYSTEM_PROMPT.to_string()),
        max_tokens: 8192,
        temperature: Some(0.2),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
    };

    let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);
    let provider_task = tokio::spawn(async move { llm.stream_chat(&api_key, request, tx).await });

    let mut accumulated = String::new();
    let mut error: Option<String> = None;

    while let Some(chunk) = rx.recv().await {
        match chunk {
            StreamChunk::TextDelta { text } => accumulated.push_str(&text),
            StreamChunk::Error { message } => {
                error = Some(message);
                break;
            }
            StreamChunk::Done { .. } => break,
            // Ideation doesn't use tools or thinking — ignore those chunk variants.
            _ => {}
        }
    }

    match provider_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            if error.is_none() {
                error = Some(e);
            }
        }
        Err(join_err) => {
            if error.is_none() {
                error = Some(format!("Provider task panicked: {}", join_err));
            }
        }
    }

    if let Some(message) = error {
        warn!("Ideation provider error: {}", message);
        return Err(message);
    }

    if accumulated.trim().is_empty() {
        return Err("The model returned an empty response.".to_string());
    }

    Ok(accumulated)
}
