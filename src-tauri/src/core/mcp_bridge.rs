//! Bridge between user-configured MCP servers and the API agent's tool list.
//!
//! v1 — discovery only. We surface ONE placeholder tool definition per enabled
//! MCP server so the LLM sees that the user has these servers configured and
//! can attempt to invoke them. Actual MCP client transport (stdio JSON-RPC,
//! capability negotiation, real per-tool discovery) is out of scope here.
//!
//! Naming convention: `mcp__<server_name>__placeholder`. Tool names are
//! sanitized (non `[A-Za-z0-9_-]` chars become `_`) so they conform to the
//! provider tool-name schemas (Anthropic / OpenAI both restrict tool names).
//!
//! Integration TODO (in `tool_runtime.rs`):
//!
//! 1. Make `tool_definitions` async (or wrap it in an async accessor) and
//!    extend the returned vec with MCP placeholders:
//!
//!    ```ignore
//!    pub async fn tool_definitions() -> Vec<ToolDefinition> {
//!        let mut defs = vec![ /* existing static defs */ ];
//!        defs.extend(crate::core::mcp_bridge::load_mcp_tool_definitions().await);
//!        defs
//!    }
//!    ```
//!
//!    All callers of `tool_definitions()` must `.await` it.
//!
//! 2. In `execute_tool`, add a dispatch arm BEFORE the catch-all so any
//!    `mcp__*` tool routes to the bridge stub:
//!
//!    ```ignore
//!    name if name.starts_with("mcp__") => {
//!        crate::core::mcp_bridge::execute_mcp_tool(name, &call.arguments).await
//!    }
//!    ```

use crate::core::llm_types::ToolDefinition;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Resolve the user's home directory in a cross-platform way.
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Path to the global Claude/PacketCode settings file that holds `mcpServers`.
fn global_settings_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("settings.json")
}

fn read_json_file(path: &PathBuf) -> Value {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(Value::Object(Default::default())),
        Err(_) => Value::Object(Default::default()),
    }
}

/// One discovered server we want to surface to the agent.
struct DiscoveredServer {
    name: String,
}

/// Read the user's global MCP server config and return enabled servers.
///
/// We intentionally only read the global file here (~/.claude/settings.json)
/// because the agent runtime is not bound to a single project path. Project
/// `.mcp.json` discovery can be layered on later via an explicit project-path
/// parameter.
fn discover_enabled_servers() -> Vec<DiscoveredServer> {
    let json = read_json_file(&global_settings_path());
    let servers = match json.get("mcpServers") {
        Some(Value::Object(map)) => map,
        _ => return Vec::new(),
    };

    servers
        .iter()
        .filter_map(|(name, val)| {
            let disabled = val
                .get("disabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if disabled {
                return None;
            }
            Some(DiscoveredServer { name: name.clone() })
        })
        .collect()
}

/// Sanitize a server name into a tool-name-safe slug.
/// Provider tool name regex is roughly `^[a-zA-Z0-9_-]{1,64}$`.
fn sanitize(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Load placeholder tool definitions for every enabled MCP server.
///
/// One synthetic tool per server, named `mcp__<server>__placeholder`. The
/// schema accepts a free-form `args` object so the model can attempt any call
/// shape — execution is stubbed in `execute_mcp_tool` until a real MCP client
/// lands.
pub fn load_mcp_tool_definitions() -> Vec<ToolDefinition> {
    let servers = discover_enabled_servers();
    servers
        .into_iter()
        .map(|s| {
            let slug = sanitize(&s.name);
            let display = s.name;
            ToolDefinition {
                name: format!("mcp__{}__placeholder", slug),
                description: format!(
                    "Invoke an action on the MCP server '{}'. (MCP client integration is pending — calls return a friendly stub for now.)",
                    display
                ),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "args": {
                            "type": "object",
                            "description": "Arbitrary arguments to forward to the MCP server. Schema is server-specific."
                        }
                    },
                    "required": []
                }),
            }
        })
        .collect()
}

/// Stub executor for any tool whose name starts with `mcp__`.
///
/// Returns an `Err` so the agent surfaces a clear, actionable message in chat:
/// the model's intent is preserved (we tell it *which* server it tried to
/// reach), but it knows the call did not actually run.
pub fn execute_mcp_tool(name: &str, _args: &serde_json::Value) -> Result<String, String> {
    // Extract the server slug from `mcp__<server>__<rest>`.
    let server = name
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split("__").next())
        .unwrap_or("<unknown>");

    Err(format!(
        "MCP client not yet wired in this PacketCode build. Tool '{}' was recognized but cannot be executed. Configured server: {}.",
        name, server
    ))
}
