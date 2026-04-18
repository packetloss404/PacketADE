//! Side-chat command: a streaming LLM helper used by the floating
//! "Side chat" overlay. The user asks ephemeral questions about their
//! main thread's context without polluting that conversation.
//!
//! Wire protocol: emits `side-chat:chunk` events with `{ delta }` for each
//! text delta from the provider stream, then a single `side-chat:done` with
//! an empty payload when complete, or `side-chat:error` on failure.

use crate::commands::api_keys;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::{
    ChatMessage, ChatRole, LlmRequest, MessageContent, StreamChunk,
};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::mpsc;
use tracing::{info, warn};

/// Default provider/model for the side chat. Anthropic + a small Haiku
/// keeps latency low for these short, context-only questions.
const DEFAULT_PROVIDER: &str = "anthropic";
const DEFAULT_MODEL: &str = "claude-haiku-4-5";

const SIDE_CHAT_CHUNK_EVENT: &str = "side-chat:chunk";
const SIDE_CHAT_DONE_EVENT: &str = "side-chat:done";
const SIDE_CHAT_ERROR_EVENT: &str = "side-chat:error";

const SYSTEM_PROMPT: &str = "You are a helper. Answer briefly using the user's main conversation context if relevant. No tool calls.";

#[derive(Clone, Serialize)]
struct SideChatChunkPayload {
    delta: String,
}

#[derive(Clone, Serialize)]
struct SideChatDonePayload {}

#[derive(Clone, Serialize)]
struct SideChatErrorPayload {
    message: String,
}

/// Emit a side-chat error and log it.
fn emit_error(app_handle: &tauri::AppHandle, message: impl Into<String>) {
    let message = message.into();
    warn!("side_chat error: {}", message);
    let _ = app_handle.emit(
        SIDE_CHAT_ERROR_EVENT,
        SideChatErrorPayload { message },
    );
}

#[tauri::command]
pub async fn ask_side_chat_stream(
    app_handle: tauri::AppHandle,
    question: String,
    context: String,
) -> Result<(), String> {
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Err("Question cannot be empty.".to_string());
    }

    super::validate_input_size(trimmed, super::MAX_INPUT_SIZE, "Side chat question")?;
    super::validate_input_size(&context, super::MAX_INPUT_SIZE, "Side chat context")?;

    let api_key = match api_keys::load_api_key(DEFAULT_PROVIDER) {
        Ok(key) => key,
        Err(e) => {
            return Err(format!(
                "Side chat requires an Anthropic API key. {}",
                e
            ));
        }
    };

    info!(
        provider = DEFAULT_PROVIDER,
        model = DEFAULT_MODEL,
        question_len = trimmed.len(),
        context_len = context.len(),
        "Side chat query"
    );

    // Build the user message: include the context block only if non-empty
    // so a fresh side chat with no main thread still works.
    let user_text = if context.trim().is_empty() {
        format!("Question: {}", trimmed)
    } else {
        format!(
            "Question: {}\n\nMain conversation context:\n{}",
            trimmed, context
        )
    };

    let messages = vec![ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(user_text),
    }];

    let request = LlmRequest {
        model: DEFAULT_MODEL.to_string(),
        messages,
        tools: Vec::new(),
        system_prompt: Some(SYSTEM_PROMPT.to_string()),
        max_tokens: 2048,
        temperature: Some(0.3),
        attachments: Vec::new(),
        thinking_enabled: false,
        thinking_budget_tokens: 0,
    };

    let provider = match get_provider(DEFAULT_PROVIDER) {
        Ok(p) => p,
        Err(e) => {
            emit_error(&app_handle, e.clone());
            return Err(e);
        }
    };

    // Spawn the provider stream in a background task and emit a chunk
    // event per text delta so the overlay can type the answer out live.
    // A single done (or error) event terminates the stream.
    let handle = app_handle.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);

        let provider_task = tokio::spawn(async move {
            provider.stream_chat(&api_key, request, tx).await
        });

        let mut total_len: usize = 0;
        let mut error: Option<String> = None;

        while let Some(chunk) = rx.recv().await {
            match chunk {
                StreamChunk::TextDelta { text } => {
                    if text.is_empty() {
                        continue;
                    }
                    total_len += text.len();
                    if let Err(e) = handle.emit(
                        SIDE_CHAT_CHUNK_EVENT,
                        SideChatChunkPayload { delta: text },
                    ) {
                        warn!("Failed to emit side-chat:chunk: {}", e);
                    }
                }
                StreamChunk::Error { message } => {
                    error = Some(message);
                    break;
                }
                StreamChunk::Done { .. } => break,
                // Side chat doesn't use tools or thinking — ignore those.
                _ => {}
            }
        }

        // Make sure the provider future has a chance to surface its own error
        // if the channel closed without a Done/Error chunk.
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
            emit_error(&handle, message);
            return;
        }

        if total_len == 0 {
            emit_error(&handle, "The model returned an empty response.");
            return;
        }

        if let Err(e) = handle.emit(SIDE_CHAT_DONE_EVENT, SideChatDonePayload {}) {
            warn!("Failed to emit side-chat:done: {}", e);
        }
    });

    Ok(())
}
