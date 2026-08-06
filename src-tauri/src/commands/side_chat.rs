//! Side-chat command: a streaming LLM helper used by the floating
//! "Side chat" overlay. The user asks ephemeral questions about their
//! main thread's context without polluting that conversation.
//!
//! Wire protocol: every event carries the caller's `requestId`, so a late
//! chunk from an older request can never bleed into a newer overlay. Closing
//! or stopping the overlay cancels the matching provider task explicitly.

use crate::commands::api_keys;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::{ChatMessage, ChatRole, LlmRequest, MessageContent, StreamChunk};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
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
#[serde(rename_all = "camelCase")]
struct SideChatChunkPayload {
    request_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SideChatDonePayload {
    request_id: String,
    cancelled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SideChatErrorPayload {
    request_id: String,
    message: String,
}

#[derive(Default)]
pub struct SideChatState {
    requests: Mutex<HashMap<String, CancellationToken>>,
}

impl SideChatState {
    fn begin(&self, request_id: &str) -> Result<CancellationToken, String> {
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Side chat request registry is unavailable.".to_string())?;
        if requests.contains_key(request_id) {
            return Err("A side chat request with this ID is already running.".to_string());
        }
        let token = CancellationToken::new();
        requests.insert(request_id.to_string(), token.clone());
        Ok(token)
    }

    fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let requests = self
            .requests
            .lock()
            .map_err(|_| "Side chat request registry is unavailable.".to_string())?;
        let Some(token) = requests.get(request_id) else {
            return Ok(false);
        };
        token.cancel();
        Ok(true)
    }

    fn finish(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }
}

/// Emit a side-chat error and log it.
fn emit_error(app_handle: &tauri::AppHandle, request_id: &str, message: impl Into<String>) {
    let message = message.into();
    warn!("side_chat error: {}", message);
    let _ = app_handle.emit(
        SIDE_CHAT_ERROR_EVENT,
        SideChatErrorPayload {
            request_id: request_id.to_string(),
            message,
        },
    );
}

#[tauri::command]
pub async fn ask_side_chat_stream(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<SideChatState>>,
    request_id: String,
    question: String,
    context: String,
) -> Result<(), String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("Side chat request ID cannot be empty.".to_string());
    }
    super::validate_input_size(&request_id, 256, "Side chat request ID")?;

    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Err("Question cannot be empty.".to_string());
    }

    super::validate_input_size(trimmed, super::MAX_INPUT_SIZE, "Side chat question")?;
    super::validate_input_size(&context, super::MAX_INPUT_SIZE, "Side chat context")?;

    let api_key = match api_keys::load_api_key(DEFAULT_PROVIDER) {
        Ok(key) => key,
        Err(e) => {
            return Err(format!("Side chat requires an Anthropic API key. {}", e));
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
        cache_key: None,
    };

    let provider = match get_provider(DEFAULT_PROVIDER) {
        Ok(p) => p,
        Err(e) => {
            emit_error(&app_handle, &request_id, e.clone());
            return Err(e);
        }
    };

    let cancel = state.begin(&request_id)?;
    let state = Arc::clone(state.inner());

    // Spawn the provider stream in a background task and emit a chunk
    // event per text delta so the overlay can type the answer out live.
    // A single done (or error) event terminates the stream.
    let handle = app_handle.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);

        let mut provider_task =
            tokio::spawn(async move { provider.stream_chat(&api_key, request, tx).await });

        let mut total_len: usize = 0;
        let mut error: Option<String> = None;

        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => {
                    provider_task.abort();
                    let _ = provider_task.await;
                    state.finish(&request_id);
                    let _ = handle.emit(
                        SIDE_CHAT_DONE_EVENT,
                        SideChatDonePayload { request_id, cancelled: true },
                    );
                    return;
                }
                chunk = rx.recv() => chunk,
            };
            let Some(chunk) = chunk else { break };
            match chunk {
                StreamChunk::TextDelta { text } => {
                    if text.is_empty() {
                        continue;
                    }
                    total_len += text.len();
                    if let Err(e) = handle.emit(
                        SIDE_CHAT_CHUNK_EVENT,
                        SideChatChunkPayload {
                            request_id: request_id.clone(),
                            delta: text,
                        },
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
        let provider_result = tokio::select! {
            _ = cancel.cancelled() => {
                provider_task.abort();
                let _ = provider_task.await;
                state.finish(&request_id);
                let _ = handle.emit(
                    SIDE_CHAT_DONE_EVENT,
                    SideChatDonePayload { request_id, cancelled: true },
                );
                return;
            }
            result = &mut provider_task => result,
        };
        match provider_result {
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
            state.finish(&request_id);
            emit_error(&handle, &request_id, message);
            return;
        }

        if total_len == 0 {
            state.finish(&request_id);
            emit_error(
                &handle,
                &request_id,
                "The model returned an empty response.",
            );
            return;
        }

        state.finish(&request_id);
        if let Err(e) = handle.emit(
            SIDE_CHAT_DONE_EVENT,
            SideChatDonePayload {
                request_id,
                cancelled: false,
            },
        ) {
            warn!("Failed to emit side-chat:done: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_side_chat_stream(
    state: tauri::State<'_, Arc<SideChatState>>,
    request_id: String,
) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(false);
    }
    state.cancel(request_id)
}

#[cfg(test)]
mod tests {
    use super::SideChatState;

    #[test]
    fn request_ids_are_unique_until_finished() {
        let state = SideChatState::default();
        assert!(state.begin("req-1").is_ok());
        assert!(state.begin("req-1").is_err());
        state.finish("req-1");
        assert!(state.begin("req-1").is_ok());
    }

    #[test]
    fn cancellation_is_scoped_and_idempotent() {
        let state = SideChatState::default();
        let first = state.begin("req-1").expect("first request");
        let second = state.begin("req-2").expect("second request");

        assert_eq!(state.cancel("missing"), Ok(false));
        assert_eq!(state.cancel("req-1"), Ok(true));
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
    }
}
