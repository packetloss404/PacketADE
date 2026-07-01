//! API-based agent session management.
//!
//! Implements the agentic tool-use loop: send messages to the LLM,
//! execute tool calls, feed results back, repeat until the model
//! produces a final text response.

use crate::commands::agent_sidecar::{is_sidecar_provider, SidecarManager};
use crate::commands::api_keys;
use crate::commands::provider_stats;
use crate::core::execution::{ExecutionTarget, SshConfig};
use crate::core::hooks::{self, HookEvent};
use crate::core::llm_provider::get_provider;
use crate::core::llm_system_prompt::build_system_prompt;
use crate::core::llm_types::*;
use crate::core::tool_runtime;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::{info, warn};

/// Maximum number of tool-use loop iterations per turn. Set high so a real
/// task runs to completion in one turn (like Cursor / Claude Code) instead of
/// hitting the cap mid-task and forcing the user to hit "Continue". Still
/// bounded to backstop a genuinely runaway agent.
const MAX_TOOL_ITERATIONS: usize = 150;

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
    /// Apply the edit. `merged_content`, when set, is the user-merged file
    /// body (per-hunk acceptance) — the agent loop swaps it in for the
    /// model's original `content` before invoking the write_file tool.
    Apply {
        merged_content: Option<String>,
    },
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
    /// Optional per-conversation MCP server allowlist. None = all enabled MCP
    /// servers; Some(empty) = no MCP servers.
    enabled_mcp_server_ids: Option<Vec<String>>,
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

async fn mark_attempt_reviewing_for_session(session_id: &str) {
    let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
        session_id,
        crate::core::flight::AttemptStatus::Reviewing,
        None,
    )
    .await;
}

async fn mark_attempt_failed_for_session(session_id: &str, message: String) {
    let _ = crate::commands::flight_attempts::update_attempt_status_by_session(
        session_id,
        crate::core::flight::AttemptStatus::Failed,
        Some(message),
    )
    .await;
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
    /// Prior file content (None for new files) so the frontend can render
    /// a real before/after diff instead of just the new content.
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeMessage {
    role: ChatRole,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ApiAgentWorkspaceInput {
    #[serde(rename = "local", rename_all = "camelCase")]
    Local { project_path: String },
    #[serde(rename = "ssh", rename_all = "camelCase")]
    Ssh {
        server_id: Option<String>,
        host: String,
        port: u16,
        user: String,
        remote_path: String,
        key_path: Option<String>,
        auth_method: Option<String>,
        host_fingerprint: Option<String>,
    },
}

fn sidecar_workspace_value(
    project_path: &str,
    ssh_config: Option<&SshConfig>,
    workspace: Option<ApiAgentWorkspaceInput>,
) -> serde_json::Value {
    if let Some(cfg) = ssh_config {
        return serde_json::json!({
            "kind": "ssh",
            "serverId": cfg.target_id.clone(),
            "host": cfg.host.clone(),
            "port": cfg.port,
            "user": cfg.user.clone(),
            "remotePath": cfg.remote_path.clone(),
            "keyPath": cfg.key_path.clone(),
            "authMethod": cfg.auth_method.clone(),
            "hostFingerprint": cfg.host_fingerprint.clone(),
        });
    }

    if let Some(ApiAgentWorkspaceInput::Local { project_path }) = workspace {
        return serde_json::json!({
            "kind": "local",
            "projectPath": project_path,
        });
    }

    serde_json::json!({
        "kind": "local",
        "projectPath": project_path,
    })
}

fn build_start_history(
    resume_messages: Option<Vec<ResumeMessage>>,
    initial_message: &str,
) -> Vec<ChatMessage> {
    let mut messages: Vec<ChatMessage> = resume_messages
        .unwrap_or_default()
        .into_iter()
        .filter_map(|message| {
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            Some(ChatMessage {
                role: message.role,
                content: MessageContent::text(content.to_string()),
            })
        })
        .collect();
    messages.push(ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(initial_message),
    });
    messages
}

fn build_assistant_history_message(
    text_content: &str,
    tool_calls: &[ToolCall],
) -> Option<ChatMessage> {
    if tool_calls.is_empty() {
        if text_content.trim().is_empty() {
            return None;
        }

        return Some(ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::text(text_content),
        });
    }

    let mut blocks = Vec::new();
    if !text_content.is_empty() {
        blocks.push(ContentBlock::Text {
            text: text_content.to_string(),
        });
    }
    for tc in tool_calls {
        blocks.push(ContentBlock::ToolUse {
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
        });
    }

    Some(ChatMessage {
        role: ChatRole::Assistant,
        content: MessageContent::Blocks(blocks),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::{McpServerConfig, McpServerEntry};
    use std::collections::HashMap;

    #[test]
    fn build_assistant_history_message_skips_blank_turn_without_tools() {
        assert!(build_assistant_history_message("", &[]).is_none());
        assert!(build_assistant_history_message(" \n\t", &[]).is_none());
    }

    #[test]
    fn build_assistant_history_message_keeps_text_turn_without_tools() {
        let message = build_assistant_history_message("done", &[]).unwrap();

        assert_eq!(message.role, ChatRole::Assistant);
        match message.content {
            MessageContent::Text(text) => assert_eq!(text, "done"),
            MessageContent::Blocks(_) => panic!("expected text content"),
        }
    }

    #[test]
    fn build_assistant_history_message_keeps_tool_turn_without_text() {
        let tool_calls = vec![ToolCall {
            id: "toolu_1".to_string(),
            name: "read_file".to_string(),
            arguments: serde_json::json!({ "path": "README.md" }),
        }];

        let message = build_assistant_history_message("", &tool_calls).unwrap();

        assert_eq!(message.role, ChatRole::Assistant);
        match message.content {
            MessageContent::Blocks(blocks) => {
                assert_eq!(blocks.len(), 1);
                match &blocks[0] {
                    ContentBlock::ToolUse {
                        id,
                        name,
                        arguments,
                    } => {
                        assert_eq!(id, "toolu_1");
                        assert_eq!(name, "read_file");
                        assert_eq!(arguments["path"], "README.md");
                    }
                    _ => panic!("expected tool use block"),
                }
            }
            MessageContent::Text(_) => panic!("expected block content"),
        }
    }

    #[test]
    fn mcp_entry_config_for_sidecar_preserves_non_stdio_server_shape() {
        let entry = McpServerEntry {
            name: "remote".to_string(),
            config: McpServerConfig {
                command: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({
                "type": "sse",
                "url": "https://example.test/mcp",
                "headers": { "Authorization": "Bearer token" },
                "disabled": false
            }),
            scope: "project".to_string(),
            disabled: false,
        };

        let config = mcp_entry_config_for_sidecar(entry);

        assert_eq!(
            config.get("type").and_then(serde_json::Value::as_str),
            Some("sse")
        );
        assert_eq!(
            config.get("url").and_then(serde_json::Value::as_str),
            Some("https://example.test/mcp")
        );
        assert!(config.contains_key("headers"));
        assert!(!config.contains_key("disabled"));
        assert!(!config.contains_key("command"));
    }

    #[test]
    fn mcp_entry_config_for_sidecar_keeps_stdio_fallback_fields() {
        let mut env = HashMap::new();
        env.insert("TOKEN".to_string(), "secret".to_string());
        let entry = McpServerEntry {
            name: "local".to_string(),
            config: McpServerConfig {
                command: "node".to_string(),
                args: vec!["server.js".to_string()],
                env,
            },
            raw_config: serde_json::json!({}),
            scope: "global".to_string(),
            disabled: false,
        };

        let config = mcp_entry_config_for_sidecar(entry);

        assert_eq!(
            config.get("type").and_then(serde_json::Value::as_str),
            Some("stdio")
        );
        assert_eq!(
            config.get("command").and_then(serde_json::Value::as_str),
            Some("node")
        );
        assert_eq!(config["args"][0], "server.js");
        assert_eq!(config["env"]["TOKEN"], "secret");
    }

    #[test]
    fn merge_mcp_entries_for_sidecar_project_disabled_shadows_global() {
        let global = McpServerEntry {
            name: "danger".to_string(),
            config: McpServerConfig {
                command: "node".to_string(),
                args: vec!["danger.js".to_string()],
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({ "command": "node", "args": ["danger.js"] }),
            scope: "global".to_string(),
            disabled: false,
        };
        let project_disabled = McpServerEntry {
            name: "danger".to_string(),
            config: McpServerConfig {
                command: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
            },
            raw_config: serde_json::json!({ "disabled": true }),
            scope: "project".to_string(),
            disabled: true,
        };

        let merged = merge_mcp_entries_for_sidecar(vec![global, project_disabled], None);

        assert!(!merged.contains_key("danger"));
    }
}

/// Fire all SessionEnd hooks (best-effort; failures logged).
async fn fire_session_end_hooks(hooks_list: &[crate::core::hooks::HookConfig], session_id: &str) {
    for hook in hooks_list
        .iter()
        .filter(|h| h.event == HookEvent::SessionEnd)
    {
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
        "openai-agents" | "api-openai-agents" => "api-openai-agents",
        "minimax" | "api-minimax" => "api-minimax",
        "minimax-api" | "api-minimax-api" => "api-minimax-api",
        "openrouter" | "api-openrouter" => "api-openrouter",
        "ollama" | "api-ollama" => "api-ollama",
        _ => "api-claude",
    }
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

/// Build the merged MCP server config to hand to the sidecar when starting a
/// subscription-auth session.
///
/// Sources:
/// - Global: `~/.claude/settings.json` under `mcpServers` (reader lives in
///   `commands::mcp`).
/// - Project: `<project_path>/.mcp.json` under `mcpServers`.
///
/// Merge rule: project entries override global entries on matching server
/// name. Entries with `disabled: true` are dropped.
///
/// Output shape (a JSON object keyed by server name):
/// ```json
/// {
///   "my-server": {
///     "type": "stdio",
///     "command": "/usr/local/bin/my-mcp",
///     "args": ["--flag"],
///     "env": { "TOKEN": "..." }
///   }
/// },
/// "http-server": {
///   "type": "sse",
///   "url": "https://example.test/mcp",
///   "headers": { "Authorization": "Bearer ..." }
/// }
/// ```
/// This preserves Claude/Codex MCP server shapes rather than coercing every
/// entry into stdio. `disabled` is consumed locally and not forwarded.
///
/// Failures reading either scope are logged to stderr; we fall back to
/// whichever scope succeeded (or an empty object if both fail). We never
/// fail the session over MCP config problems.
/// `filter` (F9): per-conversation MCP server allowlist. `None` = all
/// enabled servers (back-compat for older conversations). `Some(&[])` =
/// explicitly none. Otherwise only servers whose `name` appears in the
/// slice are forwarded.
async fn build_mcp_config_for_sidecar(
    project_path: &str,
    filter: Option<&[String]>,
) -> serde_json::Value {
    use crate::commands::mcp;
    use serde_json::{Map, Value};

    // `read_mcp_servers` concatenates global entries first, then project
    // entries, so inserting into a map in the returned order naturally lets
    // project scope overwrite global on the same server name.
    let entries = match mcp::read_mcp_servers(project_path.to_string()).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "build_mcp_config_for_sidecar: failed to read MCP servers for project '{}': {} — sending empty config",
                project_path, e
            );
            return Value::Object(Map::new());
        }
    };

    Value::Object(merge_mcp_entries_for_sidecar(entries, filter))
}

fn merge_mcp_entries_for_sidecar(
    entries: Vec<crate::commands::mcp::McpServerEntry>,
    filter: Option<&[String]>,
) -> Map<String, Value> {
    let mut merged: Map<String, Value> = Map::new();
    for entry in entries {
        if let Some(allowed) = filter {
            if !allowed.iter().any(|name| name == &entry.name) {
                continue;
            }
        }
        let name = entry.name.clone();
        if entry.disabled {
            merged.remove(&name);
            continue;
        }
        let obj = mcp_entry_config_for_sidecar(entry);
        // Later (project-scope) insertions overwrite earlier (global-scope)
        // ones with the same key — Rust's `Map::insert` replaces the value.
        merged.insert(name, Value::Object(obj));
    }

    merged
}

fn mcp_entry_config_for_sidecar(entry: crate::commands::mcp::McpServerEntry) -> Map<String, Value> {
    let mut obj = match entry.raw_config {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    obj.remove("disabled");

    let type_is_stdio = obj
        .get("type")
        .and_then(Value::as_str)
        .map(|transport| transport == "stdio")
        .unwrap_or(true);

    if type_is_stdio {
        obj.entry("type".to_string())
            .or_insert_with(|| Value::String("stdio".to_string()));
        if !entry.config.command.is_empty() {
            obj.entry("command".to_string())
                .or_insert_with(|| Value::String(entry.config.command));
        }
        obj.entry("args".to_string()).or_insert_with(|| {
            Value::Array(entry.config.args.into_iter().map(Value::String).collect())
        });
        if !entry.config.env.is_empty() {
            obj.entry("env".to_string())
                .or_insert_with(|| serde_json::json!(entry.config.env));
        }
    }

    obj
}

/// Start a new API agent session.
///
/// `resume_token`: opaque token captured from a prior `done` event (v3,
/// T3.B). When supplied and the provider is a sidecar provider, the sidecar
/// reuses the model-side conversation so the session continues across app
/// restarts. Ignored by in-process providers (their context is rebuilt from
/// the `messages` history the frontend keeps in `agentTaskStore`).
#[tauri::command]
pub async fn start_api_agent_session(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
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
    resume_token: Option<String>,
    enabled_mcp_server_ids: Option<Vec<String>>,
    resume_messages: Option<Vec<ResumeMessage>>,
    permission_mode: Option<String>,
    approve_writes: Option<bool>,
    command_path: Option<String>,
    workspace: Option<ApiAgentWorkspaceInput>,
) -> Result<(), String> {
    // v2 Tier 4 slice B: bump the local-only per-provider launch counter
    // before any routing decision so both sidecar and in-process launches are
    // counted. Best-effort — disk-write failures are logged to stderr and
    // never block the session start.
    provider_stats::record_launch(&provider);

    // Phase 3 slice C: if this provider runs in the sidecar, forward the start
    // request and return early. In-process providers fall through to the
    // existing LlmProvider runtime untouched.
    if is_sidecar_provider(&provider) {
        let is_remote_workspace = ssh_config.is_some();
        let sidecar_workspace = if is_remote_workspace {
            // The sidecar process itself runs on the remote host, so the
            // remote path is local from the sidecar's point of view. Sending
            // `kind: "ssh"` would correctly trip the sidecar's local-transport
            // guard, which is only meant to prevent accidental local execution.
            serde_json::json!({
                "kind": "local",
                "projectPath": project_path.clone(),
            })
        } else {
            sidecar_workspace_value(&project_path, None, workspace)
        };
        if provider == "openai-agents" && !is_remote_workspace {
            super::validate_project_path(&project_path)?;
        }
        let sys_prompt = system_prompt_override.clone().unwrap_or_default();
        let tools = allowed_tools.clone().unwrap_or_default();
        let api_key = if provider == "openai-agents" {
            Some(api_keys::load_api_key("openai")?)
        } else {
            None
        };
        // Merge global (~/.claude/settings.json) and project (.mcp.json) MCP
        // server configs, drop disabled entries, and transform into the shape
        // the Claude Agent SDK expects. See `build_mcp_config_for_sidecar`
        // below for the exact output shape and per-entry fields.
        let mcp_servers = if is_remote_workspace {
            if enabled_mcp_server_ids
                .as_deref()
                .map(|ids| !ids.is_empty())
                .unwrap_or(false)
            {
                return Err(
                    "Remote sidecar sessions do not support PacketADE MCP server forwarding yet. Disable MCP servers for this launch or run the provider locally.".to_string(),
                );
            }
            warn!(
                session_id = %session_id,
                provider = %provider,
                "Remote sidecar launch skips local PacketADE MCP server config"
            );
            serde_json::Value::Object(serde_json::Map::new())
        } else {
            build_mcp_config_for_sidecar(&project_path, enabled_mcp_server_ids.as_deref()).await
        };
        let sidecar_project_path = project_path.clone();
        // A locally pinned Codex executable path is not meaningful on the
        // remote host. Remote sidecars resolve provider CLIs from the remote
        // PATH; explicit remote overrides can be added once the server model
        // has a field for them.
        let sidecar_command_path = if is_remote_workspace {
            None
        } else {
            command_path.clone()
        };
        // v3: pass attachments through to the sidecar — Anthropic provider
        // builds an image-block content array when present.
        let attachments_json = match &attachments {
            Some(a) => serde_json::to_value(a).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        let resume_messages_json = match &resume_messages {
            Some(messages) => serde_json::to_value(messages).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        let result = if let Some(ssh_config) = ssh_config.clone() {
            sidecar
                .forward_start_ssh(
                    session_id.clone(),
                    provider.clone(),
                    model.clone(),
                    sys_prompt,
                    tools,
                    mcp_servers,
                    sidecar_project_path,
                    initial_message.clone(),
                    api_key,
                    resume_token.clone(),
                    thinking_enabled,
                    plan_mode,
                    attachments_json,
                    resume_messages_json,
                    permission_mode.clone(),
                    approve_writes,
                    // Flight Planner E1: no in-process MCP kind for the regular
                    // API-agent flow. The planner registers its own session via
                    // `commands::flight_planner::start_flight_planner` which
                    // sets this to `Some("planner")`.
                    None,
                    sidecar_command_path,
                    Some(sidecar_workspace),
                    ssh_config,
                )
                .await
        } else {
            sidecar
                .forward_start(
                    session_id.clone(),
                    provider.clone(),
                    model.clone(),
                    sys_prompt,
                    tools,
                    mcp_servers,
                    sidecar_project_path,
                    initial_message.clone(),
                    api_key,
                    resume_token.clone(),
                    thinking_enabled,
                    plan_mode,
                    attachments_json,
                    resume_messages_json,
                    permission_mode.clone(),
                    approve_writes,
                    // Flight Planner E1: no in-process MCP kind for the regular
                    // API-agent flow. The planner registers its own session via
                    // `commands::flight_planner::start_flight_planner` which
                    // sets this to `Some("planner")`.
                    None,
                    sidecar_command_path,
                    Some(sidecar_workspace),
                )
                .await
        };
        if let Err(e) = result {
            warn!(session_id = %session_id, error = %e, "Sidecar forward_start failed");
            let _ = app_handle.emit(
                &error_event(&session_id),
                ErrorPayload { message: e.clone() },
            );
            return Err(e);
        }
        return Ok(());
    }

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

    let parsed_permission_mode = match permission_mode.as_deref() {
        Some(mode) => PermissionMode::parse(mode)
            .ok_or_else(|| format!("Unknown permission mode: {}", mode))?,
        None => PermissionMode::Auto,
    };

    let messages = build_start_history(resume_messages, &initial_message);

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
                permission_mode: parsed_permission_mode,
                auto_allow_tools: HashSet::new(),
                approve_writes: approve_writes.unwrap_or(false),
                allowed_tools,
                enabled_mcp_server_ids,
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
        let result = run_agent_loop(&app_handle, &state_clone, &session_id_clone, cancel_rx).await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Agent loop error");
            mark_attempt_failed_for_session(&session_id_clone, e.clone()).await;
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload { message: e.clone() },
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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    message: String,
    attachments: Option<Vec<ImageAttachment>>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id) {
        let attachments_json = match &attachments {
            Some(a) => serde_json::to_value(a).unwrap_or(serde_json::Value::Null),
            None => serde_json::Value::Null,
        };
        return sidecar
            .forward_send(session_id, message, attachments_json)
            .await;
    }

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
        let result = run_agent_loop(&app_handle, &state_clone, &session_id_clone, cancel_rx).await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Agent loop error");
            mark_attempt_failed_for_session(&session_id_clone, e.clone()).await;
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload { message: e.clone() },
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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id) {
        return sidecar.forward_cancel(session_id).await;
    }

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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    new_model: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. The
    // Anthropic provider hot-swaps via SDK `setModel`; Codex stashes the
    // value for the next spawn.
    if sidecar.owns_session(&session_id) {
        return sidecar.forward_set_model(session_id, new_model).await;
    }

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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. Translate
    // the legacy boolean into the SDK's permission-mode vocabulary:
    // `true` → "plan", `false` → "default".
    if sidecar.owns_session(&session_id) {
        let mode = if enabled { "plan" } else { "default" };
        return sidecar
            .forward_set_permission_mode(session_id, mode.to_string())
            .await;
    }

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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. The
    // sidecar's Anthropic provider maps mode strings onto the SDK's
    // `setPermissionMode`; we pass the caller's string through verbatim so
    // the sidecar sees the same vocabulary the frontend picked.
    if sidecar.owns_session(&session_id) {
        return sidecar.forward_set_permission_mode(session_id, mode).await;
    }

    let parsed =
        PermissionMode::parse(&mode).ok_or_else(|| format!("Unknown permission mode: {}", mode))?;
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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    tool_id: String,
    decision: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id) {
        return sidecar
            .forward_permission(session_id, tool_id, decision)
            .await;
    }

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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. Translate
    // the legacy boolean into the SDK's permission-mode vocabulary:
    // `true` → "acceptEdits" (auto-apply writes), `false` → "default".
    // NOTE: this mapping is lossy — toggling approve_writes on top of an
    // already-customized permission mode will clobber that mode. It matches
    // the pre-sidecar in-process semantics, which also treated the two
    // knobs as orthogonal stores with the last-write winning.
    if sidecar.owns_session(&session_id) {
        let mode = if enabled { "acceptEdits" } else { "default" };
        return sidecar
            .forward_set_permission_mode(session_id, mode.to_string())
            .await;
    }

    let mut configs = state.configs.lock().await;
    let config = configs
        .get_mut(&session_id)
        .ok_or_else(|| format!("No active session: {}", session_id))?;
    config.approve_writes = enabled;
    Ok(())
}

/// Respond to a pending write-file edit approval. v3: an optional
/// `merged_content` lets the frontend land a partial-apply result (per-hunk
/// acceptance). When present, the sidecar provider writes that content
/// directly and tells the SDK's tool to skip its own write.
#[tauri::command]
pub async fn respond_edit(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    tool_id: String,
    decision: String,
    merged_content: Option<String>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id) {
        let approved = match decision.as_str() {
            "apply" => true,
            "reject" => false,
            _ => return Err(format!("Unknown edit decision: {}", decision)),
        };
        return sidecar
            .forward_edit(session_id, approved, merged_content)
            .await;
    }

    let _ = session_id;
    let decision = match decision.as_str() {
        "apply" => EditDecision::Apply { merged_content },
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

/// F8: drain every parked permission_request and pending_edit prompt as
/// denied without killing the agent loop. The tool gates each return a
/// "User cancelled this tool" result and the loop continues normally.
///
/// Limitation: the in-process pending state is a flat map keyed by tool_id
/// with no session ownership tracking. We drain ALL pending prompts on
/// cancel — in practice users only have one session waiting on prompts at
/// a time. Adding per-session ownership is a follow-up if multi-session
/// concurrent-prompt usage becomes common.
#[tauri::command]
pub async fn cancel_pending_tools(
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
) -> Result<(), String> {
    if sidecar.owns_session(&session_id) {
        return sidecar.forward_cancel_pending_tools(session_id).await;
    }

    let perm_senders: Vec<_> = {
        let mut pending = state.pending_permissions.lock().await;
        pending.drain().collect()
    };
    for (_, tx) in perm_senders {
        let _ = tx.send(PermissionDecision::Deny);
    }

    let edit_senders: Vec<_> = {
        let mut pending = state.pending_edits.lock().await;
        pending.drain().collect()
    };
    for (_, tx) in edit_senders {
        let _ = tx.send(EditDecision::Reject);
    }

    Ok(())
}

/// Retry / regenerate the last assistant turn. Optionally switch model first.
#[tauri::command]
pub async fn retry_last_turn(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<ApiAgentState>>,
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
    new_model: Option<String>,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session. If the
    // caller asked for a model swap, push that first so the retry uses the
    // new model; then emit the retry frame itself.
    if sidecar.owns_session(&session_id) {
        if let Some(model) = new_model {
            sidecar.forward_set_model(session_id.clone(), model).await?;
        }
        return sidecar.forward_retry(session_id).await;
    }

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
        let result = run_agent_loop(&app_handle, &state_clone, &session_id_clone, cancel_rx).await;

        if let Err(e) = &result {
            warn!(session_id = %session_id_clone, error = %e, "Retry loop error");
            mark_attempt_failed_for_session(&session_id_clone, e.clone()).await;
            let _ = app_handle.emit(
                &error_event(&session_id_clone),
                ErrorPayload { message: e.clone() },
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
    sidecar: tauri::State<'_, Arc<SidecarManager>>,
    session_id: String,
) -> Result<(), String> {
    // Phase 3 slice C: forward to sidecar if it owns this session.
    if sidecar.owns_session(&session_id) {
        return sidecar.forward_close(session_id).await;
    }

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
/// E8 — async-dispatched rollup of an in-process executor session's
/// turn totals onto the owning Flight DTO. Mirrors the sidecar-side hook
/// in `agent_sidecar::handle_event`'s `turn_summary` arm but lives here
/// for the LlmProvider-trait path (api-claude / api-openai / api-minimax
/// / api-openrouter / api-ollama). No-op when the session isn't linked
/// to any flight (the common standalone-chat case).
///
/// Called from every `run_agent_loop` exit point that finalizes the
/// session-cumulative token totals (cancel-early, mid-stream-cancel,
/// done-no-tool-calls, hit-max-iterations) right after the matching
/// `UsageEntry` write so the cost numbers line up with the usage log.
fn spawn_executor_cost_rollup(
    app_handle: &tauri::AppHandle,
    session_id: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_write: u64,
    cost_usd: f64,
) {
    let app = app_handle.clone();
    let session_id = session_id.to_string();
    let model = model.to_string();
    tauri::async_runtime::spawn(async move {
        let state_snap = crate::core::storage::load_state();
        let owner = match crate::commands::flight_planner::flight_for_executor_session(
            &state_snap,
            &session_id,
        ) {
            Some(o) => o,
            None => return,
        };
        let total_tokens = input_tokens
            .saturating_add(output_tokens)
            .saturating_add(cache_read)
            .saturating_add(cache_write);
        if let Err(e) = crate::commands::flight_planner::accumulate_executor_cost(
            &owner.flight_id,
            total_tokens,
            cost_usd,
        )
        .await
        {
            warn!(
                flight_id = %owner.flight_id,
                session_id = %session_id,
                error = %e,
                "E8-ACCUM: failed to accumulate in-process executor cost"
            );
            return;
        }
        let _ = app.emit(
            &format!("flight-planner:cost-updated:{}", owner.flight_id),
            serde_json::json!({
                "flightId": owner.flight_id,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cacheReadInputTokens": cache_read,
                "cacheCreationInputTokens": cache_write,
                "totalTokens": total_tokens,
                "costUsd": cost_usd,
                "source": "executor",
                "model": model,
            }),
        );
    });
}

async fn run_agent_loop(
    app_handle: &tauri::AppHandle,
    state: &Arc<ApiAgentState>,
    session_id: &str,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let (
        provider_name,
        model,
        execution,
        system_prompt,
        thinking_enabled,
        allowed_tools,
        enabled_mcp_server_ids,
    ) = {
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
            config.enabled_mcp_server_ids.clone(),
        )
    };

    let _ = get_provider(&provider_name)?;
    let api_key = api_keys::load_api_key(&provider_name)?;
    let tools = {
        let all =
            tool_runtime::tool_definitions_with_mcp_allowlist(enabled_mcp_server_ids.as_deref())
                .await;
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
    for hook in all_hooks
        .iter()
        .filter(|h| h.event == HookEvent::SessionStart)
    {
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
            mark_attempt_reviewing_for_session(session_id).await;
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
            spawn_executor_cost_rollup(
                app_handle,
                session_id,
                &model,
                total_input_tokens,
                total_output_tokens,
                total_cache_read,
                total_cache_write,
                cost,
            );
            fire_session_end_hooks(&all_hooks, session_id).await;
            return Ok(());
        }

        // Get current message history
        let messages = {
            let histories = state.histories.lock().await;
            histories.get(session_id).cloned().unwrap_or_default()
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
                    // Abort the detached stream task so the provider's
                    // `stream_chat` stops holding the upstream HTTP connection
                    // and pushing into the now-dropped mpsc channel.
                    stream_handle.abort();
                    mark_attempt_reviewing_for_session(session_id).await;
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
                    spawn_executor_cost_rollup(
                        app_handle,
                        session_id,
                        &model,
                        total_input_tokens,
                        total_output_tokens,
                        total_cache_read,
                        total_cache_write,
                        cost,
                    );
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
                            mark_attempt_failed_for_session(session_id, message.clone()).await;
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

        if let Some(assistant_msg) = build_assistant_history_message(&text_content, &tool_calls) {
            let mut histories = state.histories.lock().await;
            if let Some(history) = histories.get_mut(session_id) {
                history.push(assistant_msg);
            }
        }

        // If no tool calls, we're done
        if tool_calls.is_empty() {
            mark_attempt_reviewing_for_session(session_id).await;
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
            spawn_executor_cost_rollup(
                app_handle,
                session_id,
                &model,
                total_input_tokens,
                total_output_tokens,
                total_cache_read,
                total_cache_write,
                cost,
            );
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
            .map(|mut tc| {
                let execution = execution.clone();
                let app_handle = app_handle.clone();
                let session_id = session_id.to_string();
                let state = Arc::clone(state);
                let hooks_for_tool = all_hooks.clone();
                let enabled_mcp_server_ids = enabled_mcp_server_ids.clone();
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
                        let path = match tc
                            .arguments
                            .get("path")
                            .and_then(|v| v.as_str())
                        {
                            Some(path) => path.to_string(),
                            None => {
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "Missing 'path' parameter".to_string(),
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
                        };
                        let content = match tc
                            .arguments
                            .get("content")
                            .and_then(|v| v.as_str())
                        {
                            Some(content) => content.to_string(),
                            None => {
                                let err = ToolResult {
                                    tool_call_id: tc.id.clone(),
                                    content: "Missing 'content' parameter".to_string(),
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
                        };
                        let resolved_local_path = match &execution {
                            ExecutionTarget::Local { project_path } => {
                                match tool_runtime::resolve_workspace_path(
                                    &path,
                                    project_path,
                                    false,
                                ) {
                                    Ok(path) => Some(path),
                                    Err(e) => {
                                        let err = ToolResult {
                                            tool_call_id: tc.id.clone(),
                                            content: e,
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
                            ExecutionTarget::Ssh { .. } => None,
                        };
                        // Read prior content for before/after diff. None for
                        // new files, remote targets, or unreadable paths.
                        let before = match resolved_local_path {
                            Some(path) => tokio::fs::read_to_string(path).await.ok(),
                            None => None,
                        };

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
                                before,
                            },
                        );
                        match tokio::time::timeout(Duration::from_secs(600), rx).await {
                            Ok(Ok(EditDecision::Apply { merged_content })) => {
                                // F2: per-hunk acceptance — swap in the
                                // user-merged file body before the tool runs
                                // so the actual write writes only the hunks
                                // the user picked, not the model's full
                                // `after`.
                                if let Some(merged) = merged_content {
                                    if let Some(args) =
                                        tc.arguments.as_object_mut()
                                    {
                                        args.insert(
                                            "content".to_string(),
                                            serde_json::Value::String(merged),
                                        );
                                    }
                                }
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
                    let result = tool_runtime::execute_tool_with_mcp_allowlist(
                        &tc,
                        &execution,
                        enabled_mcp_server_ids.as_deref(),
                    )
                    .await;
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
    mark_attempt_reviewing_for_session(session_id).await;
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
    spawn_executor_cost_rollup(
        app_handle,
        session_id,
        &model,
        total_input_tokens,
        total_output_tokens,
        total_cache_read,
        total_cache_write,
        cost,
    );
    fire_session_end_hooks(&all_hooks, session_id).await;
    Ok(())
}
