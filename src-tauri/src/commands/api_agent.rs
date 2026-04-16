//! API-based agent session management.
//!
//! Implements the agentic tool-use loop: send messages to the LLM,
//! execute tool calls, feed results back, repeat until the model
//! produces a final text response.

use crate::commands::api_keys;
use crate::core::llm_provider::get_provider;
use crate::core::llm_system_prompt::build_system_prompt;
use crate::core::llm_types::*;
use crate::core::tool_runtime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{info, warn};

/// Maximum number of tool-use loop iterations to prevent runaway agents.
const MAX_TOOL_ITERATIONS: usize = 25;

/// Shared state for managing active API agent sessions.
pub struct ApiAgentState {
    /// Cancellation senders keyed by session_id.
    cancel_senders: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Message histories keyed by session_id.
    histories: Mutex<HashMap<String, Vec<ChatMessage>>>,
    /// Session configs keyed by session_id.
    configs: Mutex<HashMap<String, SessionConfig>>,
}

struct SessionConfig {
    provider: String,
    model: String,
    project_path: String,
    system_prompt: String,
}

impl ApiAgentState {
    pub fn new() -> Self {
        Self {
            cancel_senders: Mutex::new(HashMap::new()),
            histories: Mutex::new(HashMap::new()),
            configs: Mutex::new(HashMap::new()),
        }
    }
}

// Event name helpers
fn chunk_event(session_id: &str) -> String {
    format!("api-agent:chunk:{}", session_id)
}
fn tool_start_event(session_id: &str) -> String {
    format!("api-agent:tool-start:{}", session_id)
}
fn tool_result_event(session_id: &str) -> String {
    format!("api-agent:tool-result:{}", session_id)
}
fn done_event(session_id: &str) -> String {
    format!("api-agent:done:{}", session_id)
}
fn error_event(session_id: &str) -> String {
    format!("api-agent:error:{}", session_id)
}

#[derive(Clone, Serialize)]
struct ToolStartPayload {
    id: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct ToolResultPayload {
    id: String,
    name: String,
    content: String,
    is_error: bool,
    input: String,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
}

/// Map a provider name to the usage-log source string.
fn provider_to_source(provider: &str) -> &'static str {
    match provider {
        "claude" | "anthropic" | "api-claude" => "api-claude",
        "openai" | "api-openai" => "api-openai",
        "minimax" | "api-minimax" => "api-minimax",
        "openrouter" | "api-openrouter" => "api-openrouter",
        "ollama" | "api-ollama" => "api-ollama",
        _ => "api-claude",
    }
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

/// Start a new API agent session.
#[tauri::command]
pub async fn start_api_agent_session(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    provider: String,
    model: String,
    project_path: String,
    initial_message: String,
    system_prompt_override: Option<String>,
) -> Result<(), String> {
    super::validate_project_path(&project_path)?;

    // Load API key (validates provider exists)
    let _api_key = api_keys::load_api_key(&provider)?;

    let system_prompt = match system_prompt_override {
        Some(p) if !p.is_empty() => p,
        _ => build_system_prompt(&project_path),
    };

    // Create initial message history
    let messages = vec![ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(&initial_message),
    }];

    // Store session config and history
    {
        let mut configs = state.configs.lock().await;
        configs.insert(
            session_id.clone(),
            SessionConfig {
                provider: provider.clone(),
                model: model.clone(),
                project_path: project_path.clone(),
                system_prompt: system_prompt.clone(),
            },
        );

        let mut histories = state.histories.lock().await;
        histories.insert(session_id.clone(), messages.clone());
    }

    // Set up cancellation
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut senders = state.cancel_senders.lock().await;
        senders.insert(session_id.clone(), cancel_tx);
    }

    let state_clone = Arc::clone(&state.inner());
    let session_id_clone = session_id.clone();

    info!(
        session_id = %session_id,
        provider = %provider,
        model = %model,
        "Starting API agent session"
    );

    // Spawn the agentic loop
    tokio::spawn(async move {
        let result = run_agent_loop(
            &app_handle,
            &state_clone,
            &session_id_clone,
            cancel_rx,
        )
        .await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Agent loop error");
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload {
                    message: e.clone(),
                },
            );
        }

        // Cleanup cancel sender
        let mut senders = state_clone.cancel_senders.lock().await;
        senders.remove(&session_id_clone);
    });

    Ok(())
}

/// Send a follow-up message to an active API agent session.
#[tauri::command]
pub async fn send_api_agent_message(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    // Append user message to history
    {
        let mut histories = state.histories.lock().await;
        let history = histories
            .get_mut(&session_id)
            .ok_or_else(|| format!("No active session: {}", session_id))?;
        history.push(ChatMessage {
            role: ChatRole::User,
            content: MessageContent::text(&message),
        });
    }

    // Set up new cancellation for this turn
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut senders = state.cancel_senders.lock().await;
        senders.insert(session_id.clone(), cancel_tx);
    }

    let state_clone = Arc::clone(&state.inner());
    let session_id_clone = session_id.clone();

    tokio::spawn(async move {
        let result = run_agent_loop(
            &app_handle,
            &state_clone,
            &session_id_clone,
            cancel_rx,
        )
        .await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Agent loop error");
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload {
                    message: e.clone(),
                },
            );
        }

        let mut senders = state_clone.cancel_senders.lock().await;
        senders.remove(&session_id_clone);
    });

    Ok(())
}

/// Cancel an active API agent session.
#[tauri::command]
pub async fn cancel_api_agent_session(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
) -> Result<(), String> {
    let mut senders = state.cancel_senders.lock().await;
    if let Some(tx) = senders.remove(&session_id) {
        let _ = tx.send(());
        info!(session_id = %session_id, "API agent session cancelled");
    }
    Ok(())
}

/// Change the model for an active session. Subsequent turns will use the new model.
#[tauri::command]
pub async fn change_model(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    new_model: String,
) -> Result<(), String> {
    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.model = new_model;
    Ok(())
}

/// Clean up a session's state when done.
#[tauri::command]
pub async fn close_api_agent_session(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
) -> Result<(), String> {
    // Cancel if running
    {
        let mut senders = state.cancel_senders.lock().await;
        if let Some(tx) = senders.remove(&session_id) {
            let _ = tx.send(());
        }
    }
    // Remove history and config
    {
        let mut histories = state.histories.lock().await;
        histories.remove(&session_id);
    }
    {
        let mut configs = state.configs.lock().await;
        configs.remove(&session_id);
    }
    info!(session_id = %session_id, "API agent session closed");
    Ok(())
}

/// The core agentic loop: call LLM → execute tools → repeat.
async fn run_agent_loop(
    app_handle: &tauri::AppHandle,
    state: &Arc<ApiAgentState>,
    session_id: &str,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (provider_name, model, project_path, system_prompt) = {
        let configs = state.configs.lock().await;
        let config = configs
            .get(session_id)
            .ok_or_else(|| format!("No session config: {}", session_id))?;
        (
            config.provider.clone(),
            config.model.clone(),
            config.project_path.clone(),
            config.system_prompt.clone(),
        )
    };

    let provider = get_provider(&provider_name)?;
    let api_key = api_keys::load_api_key(&provider_name)?;
    let tools = tool_runtime::tool_definitions();
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_write: u64 = 0;

    let source = provider_to_source(&provider_name);

    for iteration in 0..MAX_TOOL_ITERATIONS {
        // Check cancellation
        if cancel_rx.try_recv().is_ok() {
            let _ = app_handle.emit(
                &done_event(session_id),
                DonePayload {
                    input_tokens: total_input_tokens,
                    output_tokens: total_output_tokens,
                    cache_read_input_tokens: total_cache_read,
                    cache_creation_input_tokens: total_cache_write,
                },
            );
            let cost = crate::commands::pricing::calculate_cost(
                &model,
                total_input_tokens,
                total_output_tokens,
                total_cache_read,
                total_cache_write,
            );
            let entry = crate::commands::usage::UsageEntry {
                ts: crate::commands::usage::current_timestamp_iso(),
                source: source.to_string(),
                model: model.clone(),
                agent_id: None,
                session_id: session_id.to_string(),
                input_tokens: total_input_tokens,
                output_tokens: total_output_tokens,
                cache_read: total_cache_read,
                cache_write: total_cache_write,
                cost_usd: cost,
            };
            let _ = crate::commands::usage::append_usage_entry(&entry);
            return Ok(());
        }

        // Get current message history
        let messages = {
            let histories = state.histories.lock().await;
            histories
                .get(session_id)
                .cloned()
                .unwrap_or_default()
        };

        let request = LlmRequest {
            model: model.clone(),
            messages,
            tools: tools.clone(),
            system_prompt: Some(system_prompt.clone()),
            max_tokens: 16384,
            temperature: None,
        };

        // Stream the response
        let (tx, mut rx) = mpsc::channel::<StreamChunk>(64);
        let provider_ref = get_provider(&provider_name)?;
        let api_key_clone = api_key.clone();
        let request_clone = request;

        let stream_handle = tokio::spawn(async move {
            provider_ref
                .stream_chat(&api_key_clone, request_clone, tx)
                .await
        });

        let mut text_content = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut current_tool_id = String::new();
        let mut current_tool_name = String::new();
        let mut current_tool_args = String::new();
        let mut got_error = false;

        // Process stream chunks
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    let _ = app_handle.emit(
                        &done_event(session_id),
                        DonePayload {
                            input_tokens: total_input_tokens,
                            output_tokens: total_output_tokens,
                            cache_read_input_tokens: total_cache_read,
                            cache_creation_input_tokens: total_cache_write,
                        },
                    );
                    let cost = crate::commands::pricing::calculate_cost(
                        &model,
                        total_input_tokens,
                        total_output_tokens,
                        total_cache_read,
                        total_cache_write,
                    );
                    let entry = crate::commands::usage::UsageEntry {
                        ts: crate::commands::usage::current_timestamp_iso(),
                        source: source.to_string(),
                        model: model.clone(),
                        agent_id: None,
                        session_id: session_id.to_string(),
                        input_tokens: total_input_tokens,
                        output_tokens: total_output_tokens,
                        cache_read: total_cache_read,
                        cache_write: total_cache_write,
                        cost_usd: cost,
                    };
                    let _ = crate::commands::usage::append_usage_entry(&entry);
                    return Ok(());
                }
                chunk = rx.recv() => {
                    match chunk {
                        None => break, // Channel closed
                        Some(StreamChunk::TextDelta { text }) => {
                            text_content.push_str(&text);
                            let _ = app_handle.emit(&chunk_event(session_id), &text);
                        }
                        Some(StreamChunk::ToolUseStart { id, name }) => {
                            current_tool_id = id.clone();
                            current_tool_name = name.clone();
                            current_tool_args.clear();
                            let _ = app_handle.emit(
                                &tool_start_event(session_id),
                                ToolStartPayload { id, name },
                            );
                        }
                        Some(StreamChunk::ToolUseInputDelta { delta }) => {
                            current_tool_args.push_str(&delta);
                        }
                        Some(StreamChunk::ToolUseEnd { id, name, arguments }) => {
                            tool_calls.push(ToolCall { id, name, arguments });
                            current_tool_id.clear();
                            current_tool_name.clear();
                            current_tool_args.clear();
                        }
                        Some(StreamChunk::Done {
                            input_tokens,
                            output_tokens,
                            cache_read_input_tokens,
                            cache_creation_input_tokens,
                        }) => {
                            total_input_tokens += input_tokens;
                            total_output_tokens += output_tokens;
                            total_cache_read += cache_read_input_tokens;
                            total_cache_write += cache_creation_input_tokens;
                            break;
                        }
                        Some(StreamChunk::Error { message }) => {
                            let _ = app_handle.emit(
                                &error_event(session_id),
                                ErrorPayload { message },
                            );
                            got_error = true;
                            break;
                        }
                    }
                }
            }
        }

        // Wait for the stream task to finish
        let _ = stream_handle.await;

        if got_error {
            return Err("LLM returned an error".to_string());
        }

        // Build the assistant message with content blocks
        let assistant_msg = if tool_calls.is_empty() {
            ChatMessage {
                role: ChatRole::Assistant,
                content: MessageContent::text(&text_content),
            }
        } else {
            let mut blocks = Vec::new();
            if !text_content.is_empty() {
                blocks.push(ContentBlock::Text {
                    text: text_content.clone(),
                });
            }
            for tc in &tool_calls {
                blocks.push(ContentBlock::ToolUse {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: tc.arguments.clone(),
                });
            }
            ChatMessage {
                role: ChatRole::Assistant,
                content: MessageContent::Blocks(blocks),
            }
        };

        // Append assistant message to history
        {
            let mut histories = state.histories.lock().await;
            if let Some(history) = histories.get_mut(session_id) {
                history.push(assistant_msg);
            }
        }

        // If no tool calls, we're done
        if tool_calls.is_empty() {
            let _ = app_handle.emit(
                &done_event(session_id),
                DonePayload {
                    input_tokens: total_input_tokens,
                    output_tokens: total_output_tokens,
                    cache_read_input_tokens: total_cache_read,
                    cache_creation_input_tokens: total_cache_write,
                },
            );
            let cost = crate::commands::pricing::calculate_cost(
                &model,
                total_input_tokens,
                total_output_tokens,
                total_cache_read,
                total_cache_write,
            );
            let entry = crate::commands::usage::UsageEntry {
                ts: crate::commands::usage::current_timestamp_iso(),
                source: source.to_string(),
                model: model.clone(),
                agent_id: None,
                session_id: session_id.to_string(),
                input_tokens: total_input_tokens,
                output_tokens: total_output_tokens,
                cache_read: total_cache_read,
                cache_write: total_cache_write,
                cost_usd: cost,
            };
            let _ = crate::commands::usage::append_usage_entry(&entry);
            return Ok(());
        }

        // Execute tool calls and append results
        let mut tool_result_blocks = Vec::new();
        for tc in &tool_calls {
            let result = tool_runtime::execute_tool(tc, &project_path).await;

            let _ = app_handle.emit(
                &tool_result_event(session_id),
                ToolResultPayload {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    content: result.content.clone(),
                    is_error: result.is_error,
                    input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                },
            );

            tool_result_blocks.push(ContentBlock::ToolResult {
                tool_call_id: result.tool_call_id,
                content: result.content,
                is_error: result.is_error,
            });
        }

        // Append tool results as a tool message
        {
            let mut histories = state.histories.lock().await;
            if let Some(history) = histories.get_mut(session_id) {
                history.push(ChatMessage {
                    role: ChatRole::Tool,
                    content: MessageContent::Blocks(tool_result_blocks),
                });
            }
        }

        info!(
            session_id = %session_id,
            iteration = iteration,
            tool_count = tool_calls.len(),
            "Agent loop: executed tools, continuing"
        );
    }

    // Hit max iterations
    warn!(session_id = %session_id, "Agent loop hit max iterations ({})", MAX_TOOL_ITERATIONS);
    let _ = app_handle.emit(
        &done_event(session_id),
        DonePayload {
            input_tokens: total_input_tokens,
            output_tokens: total_output_tokens,
            cache_read_input_tokens: total_cache_read,
            cache_creation_input_tokens: total_cache_write,
        },
    );
    let cost = crate::commands::pricing::calculate_cost(
        &model,
        total_input_tokens,
        total_output_tokens,
        total_cache_read,
        total_cache_write,
    );
    let entry = crate::commands::usage::UsageEntry {
        ts: crate::commands::usage::current_timestamp_iso(),
        source: source.to_string(),
        model: model.clone(),
        agent_id: None,
        session_id: session_id.to_string(),
        input_tokens: total_input_tokens,
        output_tokens: total_output_tokens,
        cache_read: total_cache_read,
        cache_write: total_cache_write,
        cost_usd: cost,
    };
    let _ = crate::commands::usage::append_usage_entry(&entry);
    Ok(())
}
