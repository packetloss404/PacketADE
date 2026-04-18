//! API-based agent session management.
//!
//! Implements the agentic tool-use loop: send messages to the LLM,
//! execute tool calls, feed results back, repeat until the model
//! produces a final text response.

use crate::commands::api_keys;
use crate::core::execution::{ExecutionTarget, SshConfig};
use crate::core::hooks::{self, HookEvent};
use crate::core::llm_provider::get_provider;
use crate::core::llm_system_prompt::build_system_prompt;
use crate::core::llm_types::*;
use crate::core::tool_runtime;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{info, warn};

/// Maximum number of tool-use loop iterations to prevent runaway agents.
const MAX_TOOL_ITERATIONS: usize = 25;

/// Permission modes for risky tool calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Model's implicit authority — no prompts (default, matches prior behavior).
    Auto,
    /// Prompt the user before running risky tools (bash, write_file).
    AskForRisky,
    /// Allow all tools without prompts.
    AllowAll,
    /// Deny all risky tools.
    DenyAll,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::Auto
    }
}

impl PermissionMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "ask_for_risky" => Some(Self::AskForRisky),
            "allow_all" => Some(Self::AllowAll),
            "deny_all" => Some(Self::DenyAll),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    Deny,
}

#[derive(Debug, Clone)]
pub enum EditDecision {
    Apply,
    Reject,
}

/// Shared state for managing active API agent sessions.
pub struct ApiAgentState {
    /// Cancellation senders keyed by session_id.
    cancel_senders: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Message histories keyed by session_id.
    histories: Mutex<HashMap<String, Vec<ChatMessage>>>,
    /// Session configs keyed by session_id.
    configs: Mutex<HashMap<String, SessionConfig>>,
    /// Pending permission prompts keyed by tool_call id.
    pending_permissions: Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>,
    /// Pending write_file edits awaiting user approval, keyed by tool_call id.
    pending_edits: Mutex<HashMap<String, oneshot::Sender<EditDecision>>>,
}

struct SessionConfig {
    provider: String,
    model: String,
    execution: ExecutionTarget,
    system_prompt: String,
    // New feature fields — all default to backward-compatible values.
    thinking_enabled: bool,
    pending_attachments: Vec<ImageAttachment>,
    plan_mode: bool,
    permission_mode: PermissionMode,
    auto_allow_tools: HashSet<String>,
    approve_writes: bool,
    /// Optional allowlist of tool names. None = all tools; Some(list) = only those.
    /// Used by the Scout profile for read-only investigation.
    allowed_tools: Option<Vec<String>>,
}

impl ApiAgentState {
    pub fn new() -> Self {
        Self {
            cancel_senders: Mutex::new(HashMap::new()),
            histories: Mutex::new(HashMap::new()),
            configs: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            pending_edits: Mutex::new(HashMap::new()),
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
fn thinking_event(session_id: &str) -> String {
    format!("api-agent:thinking:{}", session_id)
}
fn thinking_stop_event(session_id: &str) -> String {
    format!("api-agent:thinking-stop:{}", session_id)
}
fn permission_request_event(session_id: &str) -> String {
    format!("api-agent:permission-request:{}", session_id)
}
fn pending_edit_event(session_id: &str) -> String {
    format!("api-agent:pending-edit:{}", session_id)
}

#[derive(Clone, Serialize)]
struct ToolStartPayload {
    id: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct PermissionRequestPayload {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Serialize)]
struct PendingEditPayload {
    id: String,
    path: String,
    content: String,
}

#[derive(Clone, Serialize)]
struct ThinkingPayload {
    text: String,
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

/// Fire all SessionEnd hooks (best-effort; failures logged).
async fn fire_session_end_hooks(
    hooks_list: &[crate::core::hooks::HookConfig],
    session_id: &str,
) {
    for hook in hooks_list.iter().filter(|h| h.event == HookEvent::SessionEnd) {
        let payload = serde_json::json!({
            "session_id": session_id,
            "event": "SessionEnd",
        });
        if let Err(e) = hooks::run_hook(hook, payload).await {
            warn!(session_id = %session_id, error = %e, "SessionEnd hook failed");
        }
    }
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
    thinking_enabled: Option<bool>,
    attachments: Option<Vec<ImageAttachment>>,
    plan_mode: Option<bool>,
    ssh_config: Option<SshConfig>,
    allowed_tools: Option<Vec<String>>,
) -> Result<(), String> {
    // Decide execution target. For SSH we skip the local-path validation and
    // use the remote path as the workspace label in the prompt.
    let execution = if let Some(cfg) = ssh_config {
        ExecutionTarget::Ssh { config: cfg }
    } else {
        super::validate_project_path(&project_path)?;
        ExecutionTarget::Local {
            project_path: project_path.clone(),
        }
    };

    // Load API key (validates provider exists)
    let _api_key = api_keys::load_api_key(&provider)?;

    let prompt_workspace = execution.label();
    let system_prompt = match system_prompt_override {
        Some(p) if !p.is_empty() => p,
        _ => build_system_prompt(&prompt_workspace),
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
                execution,
                system_prompt: system_prompt.clone(),
                thinking_enabled: thinking_enabled.unwrap_or(false),
                pending_attachments: attachments.unwrap_or_default(),
                plan_mode: plan_mode.unwrap_or(false),
                permission_mode: PermissionMode::Auto,
                auto_allow_tools: HashSet::new(),
                approve_writes: false,
                allowed_tools,
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
    attachments: Option<Vec<ImageAttachment>>,
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

    // Replace per-turn attachments if caller provided new ones.
    if let Some(new_attachments) = attachments {
        let mut configs = state.configs.lock().await;
        if let Some(cfg) = configs.get_mut(&session_id) {
            cfg.pending_attachments = new_attachments;
        }
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

/// Toggle plan mode (read-only tool allowlist) for a session.
#[tauri::command]
pub async fn set_plan_mode(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.plan_mode = enabled;
    Ok(())
}

/// Change the permission mode for a session.
#[tauri::command]
pub async fn set_permission_mode(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    let parsed = PermissionMode::parse(&mode)
        .ok_or_else(|| format!("Unknown permission mode: {}", mode))?;
    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.permission_mode = parsed;
    Ok(())
}

/// Respond to a pending permission request.
#[tauri::command]
pub async fn respond_permission(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    tool_id: String,
    decision: String,
) -> Result<(), String> {
    let _ = session_id;
    let decision = match decision.as_str() {
        "allow_once" => PermissionDecision::AllowOnce,
        "allow_always" => PermissionDecision::AllowAlways,
        "deny" => PermissionDecision::Deny,
        _ => return Err(format!("Unknown decision: {}", decision)),
    };
    let sender = {
        let mut pending = state.pending_permissions.lock().await;
        pending.remove(&tool_id)
    };
    if let Some(tx) = sender {
        let _ = tx.send(decision);
    } else {
        warn!(tool_id = %tool_id, "No pending permission for tool_id — likely already timed out or cancelled");
    }
    Ok(())
}

/// Toggle per-session approve-writes mode (user must confirm every write_file).
#[tauri::command]
pub async fn set_approve_writes(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.approve_writes = enabled;
    Ok(())
}

/// Respond to a pending write-file edit approval.
#[tauri::command]
pub async fn respond_edit(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    tool_id: String,
    decision: String,
) -> Result<(), String> {
    let _ = session_id;
    let decision = match decision.as_str() {
        "apply" => EditDecision::Apply,
        "reject" => EditDecision::Reject,
        _ => return Err(format!("Unknown edit decision: {}", decision)),
    };
    let sender = {
        let mut pending = state.pending_edits.lock().await;
        pending.remove(&tool_id)
    };
    if let Some(tx) = sender {
        let _ = tx.send(decision);
    } else {
        warn!(tool_id = %tool_id, "No pending edit for tool_id — likely already timed out or cancelled");
    }
    Ok(())
}

/// Retry / regenerate the last assistant turn. Optionally switch model first.
#[tauri::command]
pub async fn retry_last_turn(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    session_id: String,
    new_model: Option<String>,
) -> Result<(), String> {
    // Truncate history to before the last assistant message (and any trailing tool messages).
    {
        let mut histories = state.histories.lock().await;
        let history = histories
            .get_mut(&session_id)
            .ok_or_else(|| format!("No active session: {}", session_id))?;
        // Walk backward, find the last Assistant index, truncate there.
        if let Some(last_assistant) = history
            .iter()
            .rposition(|m| matches!(m.role, ChatRole::Assistant))
        {
            history.truncate(last_assistant);
        } else {
            return Err("No assistant turn to retry".to_string());
        }
    }

    // Swap model if requested.
    if let Some(model) = new_model {
        let mut configs = state.configs.lock().await;
        if let Some(cfg) = configs.get_mut(&session_id) {
            cfg.model = model;
        }
    }

    // Kick off a new turn with the existing history.
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
            warn!(session_id = %session_id_clone, error = %e, "Retry loop error");
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
    let (provider_name, model, execution, system_prompt, thinking_enabled, allowed_tools) = {
        let configs = state.configs.lock().await;
        let config = configs
            .get(session_id)
            .ok_or_else(|| format!("No session config: {}", session_id))?;
        (
            config.provider.clone(),
            config.model.clone(),
            config.execution.clone(),
            config.system_prompt.clone(),
            config.thinking_enabled,
            config.allowed_tools.clone(),
        )
    };

    let provider = get_provider(&provider_name)?;
    let api_key = api_keys::load_api_key(&provider_name)?;
    let tools = {
        let all = tool_runtime::tool_definitions().await;
        match allowed_tools.as_ref() {
            Some(allow) => all
                .into_iter()
                .filter(|t| allow.iter().any(|n| n == &t.name))
                .collect(),
            None => all,
        }
    };
    let mut total_input_tokens: u64 = 0;
    let mut total_output_tokens: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_write: u64 = 0;

    let source = provider_to_source(&provider_name);

    // Load hooks once per loop (covers global + this session's project).
    let project_path_for_hooks = match &execution {
        ExecutionTarget::Local { project_path } => project_path.clone(),
        _ => String::new(),
    };
    let all_hooks = hooks::load_hooks_with_project(&project_path_for_hooks);

    // Fire SessionStart hooks (best-effort, no veto).
    for hook in all_hooks.iter().filter(|h| h.event == HookEvent::SessionStart) {
        let payload = serde_json::json!({
            "session_id": session_id,
            "provider": provider_name,
            "model": model,
        });
        if let Err(e) = hooks::run_hook(hook, payload).await {
            warn!(session_id = %session_id, error = %e, "SessionStart hook failed");
        }
    }

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
            fire_session_end_hooks(&all_hooks, session_id).await;
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

        // Take pending attachments (only apply to iteration 0 — tool-result iterations don't re-attach).
        let pending_attachments = if iteration == 0 {
            let mut configs = state.configs.lock().await;
            if let Some(cfg) = configs.get_mut(session_id) {
                std::mem::take(&mut cfg.pending_attachments)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        let request = LlmRequest {
            model: model.clone(),
            messages,
            tools: tools.clone(),
            system_prompt: Some(system_prompt.clone()),
            max_tokens: 16384,
            temperature: None,
            attachments: pending_attachments,
            thinking_enabled,
            thinking_budget_tokens: 8000,
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
                    fire_session_end_hooks(&all_hooks, session_id).await;
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
                        Some(StreamChunk::ThinkingDelta { text }) => {
                            let _ = app_handle.emit(
                                &thinking_event(session_id),
                                ThinkingPayload { text },
                            );
                        }
                        Some(StreamChunk::ThinkingStop) => {
                            let _ = app_handle.emit(&thinking_stop_event(session_id), ());
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
            fire_session_end_hooks(&all_hooks, session_id).await;
            return Ok(());
        }

        // Re-read config for this iteration — plan_mode/permission_mode/approve_writes may flip mid-session.
        let (plan_mode_active, permission_mode, approve_writes) = {
            let configs = state.configs.lock().await;
            if let Some(cfg) = configs.get(session_id) {
                (cfg.plan_mode, cfg.permission_mode, cfg.approve_writes)
            } else {
                (false, PermissionMode::Auto, false)
            }
        };

        const RISKY_TOOLS: &[&str] = &["bash", "write_file"];
        const PLAN_MODE_ALLOWED: &[&str] = &["read_file", "list_directory", "grep"];

        // Execute tool calls in parallel; each async block handles its own gates.
        let futures: Vec<_> = tool_calls
            .iter()
            .cloned()
            .map(|tc| {
                let execution = execution.clone();
                let app_handle = app_handle.clone();
                let session_id = session_id.to_string();
                let state = Arc::clone(state);
                let hooks_for_tool = all_hooks.clone();
                async move {
                    // Plan mode gate
                    if plan_mode_active && !PLAN_MODE_ALLOWED.contains(&tc.name.as_str()) {
                        let err = ToolResult {
                            tool_call_id: tc.id.clone(),
                            content: format!(
                                "Plan mode is active — '{}' is disabled. Ask the user to exit plan mode first.",
                                tc.name
                            ),
                            is_error: true,
                        };
                        let _ = app_handle.emit(
                            &tool_result_event(&session_id),
                            ToolResultPayload {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                content: err.content.clone(),
                                is_error: true,
                                input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            },
                        );
                        return (tc.id.clone(), err);
                    }

                    // Permission gate (risky tools only)
                    if RISKY_TOOLS.contains(&tc.name.as_str()) {
                        let auto_allowed = {
                            let configs = state.configs.lock().await;
                            configs
                                .get(&session_id)
                                .map(|c| c.auto_allow_tools.contains(&tc.name))
                                .unwrap_or(false)
                        };

                        let should_ask = !auto_allowed
                            && matches!(permission_mode, PermissionMode::AskForRisky);
                        let should_deny = matches!(permission_mode, PermissionMode::DenyAll);

                        if should_deny {
                            let err = ToolResult {
                                tool_call_id: tc.id.clone(),
                                content: "Permissions: all risky tools are denied.".to_string(),
                                is_error: true,
                            };
                            let _ = app_handle.emit(
                                &tool_result_event(&session_id),
                                ToolResultPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    content: err.content.clone(),
                                    is_error: true,
                                    input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                                },
                            );
                            return (tc.id.clone(), err);
                        }

                        if should_ask {
                            let (tx, rx) = oneshot::channel::<PermissionDecision>();
                            {
                                let mut pending = state.pending_permissions.lock().await;
                                pending.insert(tc.id.clone(), tx);
                            }
                            let _ = app_handle.emit(
                                &permission_request_event(&session_id),
                                PermissionRequestPayload {
                                    id: tc.id.clone(),
                                    name: tc.name.clone(),
                                    arguments: serde_json::to_string(&tc.arguments)
                                        .unwrap_or_default(),
                                },
                            );
                            match tokio::time::timeout(Duration::from_secs(300), rx).await {
                                Ok(Ok(PermissionDecision::AllowOnce)) => {
                                    // proceed
                                }
                                Ok(Ok(PermissionDecision::AllowAlways)) => {
                                    let mut configs = state.configs.lock().await;
                                    if let Some(cfg) = configs.get_mut(&session_id) {
                                        cfg.auto_allow_tools.insert(tc.name.clone());
                                    }
                                }
                                Ok(Ok(PermissionDecision::Deny)) | Ok(Err(_)) => {
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content: "User denied permission for this tool call."
                                            .to_string(),
                                        is_error: true,
                                    };
                                    let _ = app_handle.emit(
                                        &tool_result_event(&session_id),
                                        ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments)
                                                .unwrap_or_default(),
                                        },
                                    );
                                    return (tc.id.clone(), err);
                                }
                                Err(_) => {
                                    // Timed out — remove stale entry and deny.
                                    {
                                        let mut pending = state.pending_permissions.lock().await;
                                        pending.remove(&tc.id);
                                    }
                                    let err = ToolResult {
                                        tool_call_id: tc.id.clone(),
                                        content: "Permission request timed out.".to_string(),
                                        is_error: true,
                                    };
                                    let _ = app_handle.emit(
                                        &tool_result_event(&session_id),
                                        ToolResultPayload {
                                            id: tc.id.clone(),
                                            name: tc.name.clone(),
                                            content: err.content.clone(),
                                            is_error: true,
                                            input: serde_json::to_string(&tc.arguments)
                                                .unwrap_or_default(),
                                        },
                                    );
                                    return (tc.id.clone(), err);
                                }
                            }
                        }
                    }

                    // Pending edit gate (write_file with approve_writes enabled)
                    if tc.name == "write_file" && approve_writes {
                        let path = tc
                            .arguments
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let content = tc
                            .arguments
                            .get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let (tx, rx) = oneshot::channel::<EditDecision>();
                        {
                            let mut pending = state.pending_edits.lock().await;
                            pending.insert(tc.id.clone(), tx);
                        }
                        let _ = app_handle.emit(
                            &pending_edit_event(&session_id),
                            PendingEditPayload {
                                id: tc.id.clone(),
                                path,
                                content,
                            },
                        );
                        match tokio::time::timeout(Duration::from_secs(600), rx).await {
                            Ok(Ok(EditDecision::Apply)) => {
                                // proceed
                            }
                            Ok(Ok(EditDecision::Reject)) | Ok(Err(_)) => {
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "User rejected this edit.".to_string(),
                                    is_error: true,
                                };
                                let _ = app_handle.emit(
                                    &tool_result_event(&session_id),
                                    ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments)
                                            .unwrap_or_default(),
                                    },
                                );
                                return (tc.id.clone(), err);
                            }
                            Err(_) => {
                                {
                                    let mut pending = state.pending_edits.lock().await;
                                    pending.remove(&tc.id);
                                }
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "Edit approval timed out.".to_string(),
                                    is_error: true,
                                };
                                let _ = app_handle.emit(
                                    &tool_result_event(&session_id),
                                    ToolResultPayload {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        content: err.content.clone(),
                                        is_error: true,
                                        input: serde_json::to_string(&tc.arguments)
                                            .unwrap_or_default(),
                                    },
                                );
                                return (tc.id.clone(), err);
                            }
                        }
                    }

                    // PreToolUse hooks — non-zero exit vetoes the tool call.
                    let mut vetoed_by: Option<String> = None;
                    for hook in hooks_for_tool
                        .iter()
                        .filter(|h| h.event == HookEvent::PreToolUse)
                    {
                        if !hooks::matches_tool_call(
                            hook.matcher.as_deref(),
                            &tc.name,
                            &tc.arguments,
                        ) {
                            continue;
                        }
                        let payload = serde_json::json!({
                            "session_id": session_id,
                            "event": "PreToolUse",
                            "tool_name": tc.name,
                            "tool_input": tc.arguments,
                        });
                        match hooks::run_hook(hook, payload).await {
                            Ok(res) if res.veto => {
                                vetoed_by = Some(hook.command.clone());
                                break;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                warn!(
                                    session_id = %session_id,
                                    tool = %tc.name,
                                    error = %e,
                                    "PreToolUse hook failed (treating as allow)"
                                );
                            }
                        }
                    }

                    if let Some(hook_cmd) = vetoed_by {
                        let err = ToolResult {
                            tool_call_id: tc.id.clone(),
                            content: format!("Blocked by PreToolUse hook: {}", hook_cmd),
                            is_error: true,
                        };
                        let _ = app_handle.emit(
                            &tool_result_event(&session_id),
                            ToolResultPayload {
                                id: tc.id.clone(),
                                name: tc.name.clone(),
                                content: err.content.clone(),
                                is_error: true,
                                input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                            },
                        );
                        return (tc.id.clone(), err);
                    }

                    // Execute tool
                    let result = tool_runtime::execute_tool(&tc, &execution).await;
                    let _ = app_handle.emit(
                        &tool_result_event(&session_id),
                        ToolResultPayload {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            content: result.content.clone(),
                            is_error: result.is_error,
                            input: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        },
                    );

                    // PostToolUse hooks — best-effort; failures logged.
                    for hook in hooks_for_tool
                        .iter()
                        .filter(|h| h.event == HookEvent::PostToolUse)
                    {
                        if !hooks::matches_tool_call(
                            hook.matcher.as_deref(),
                            &tc.name,
                            &tc.arguments,
                        ) {
                            continue;
                        }
                        let payload = serde_json::json!({
                            "session_id": session_id,
                            "event": "PostToolUse",
                            "tool_name": tc.name,
                            "tool_input": tc.arguments,
                            "tool_result": result.content,
                            "is_error": result.is_error,
                        });
                        if let Err(e) = hooks::run_hook(hook, payload).await {
                            warn!(
                                session_id = %session_id,
                                tool = %tc.name,
                                error = %e,
                                "PostToolUse hook failed"
                            );
                        }
                    }

                    (tc.id.clone(), result)
                }
            })
            .collect();

        let raw_results = futures::future::join_all(futures).await;

        // Rebuild tool_result_blocks in the original tool_calls order (critical for Anthropic pairing).
        let results_map: HashMap<String, ToolResult> = raw_results.into_iter().collect();
        let mut tool_result_blocks = Vec::with_capacity(tool_calls.len());
        for tc in &tool_calls {
            if let Some(result) = results_map.get(&tc.id) {
                tool_result_blocks.push(ContentBlock::ToolResult {
                    tool_call_id: result.tool_call_id.clone(),
                    content: result.content.clone(),
                    is_error: result.is_error,
                });
            }
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
    fire_session_end_hooks(&all_hooks, session_id).await;
    Ok(())
}
