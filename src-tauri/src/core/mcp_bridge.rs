//! Bridge between user-configured MCP servers and the API agent's tool list.
//!
//! Discovers tools by spawning each enabled MCP server (via `McpConnectionPool`)
//! and calling `tools/list`. Each discovered tool becomes a `ToolDefinition`
//! named `mcp__<sanitized_server>__<sanitized_tool>` so it conforms to
//! provider tool-name regex (`^[A-Za-z0-9_-]{1,64}$`).
//!
//! Execution is dispatched in `tool_runtime::execute_tool` via the
//! `mcp__*` arm, which calls back into `execute_mcp_tool` here.

use crate::core::llm_types::ToolDefinition;
use crate::core::mcp_client::McpConnectionPool;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tracing::warn;

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

/// Path to the global Claude/PacketADE settings file that holds `mcpServers`.
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

/// Read the user's global MCP server config and return enabled server names.
fn discover_enabled_servers() -> Vec<String> {
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
            Some(name.clone())
        })
        .collect()
}

/// Sanitize a name into a tool-name-safe slug.
/// Provider tool name regex is roughly `^[a-zA-Z0-9_-]{1,64}$`.
fn sanitize(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Build the canonical agent-facing tool name for a (server, tool) pair.
fn make_tool_name(server: &str, tool: &str) -> String {
    let mut name = format!("mcp__{}__{}", sanitize(server), sanitize(tool));
    // Provider tool names are capped at 64 chars. Truncate defensively.
    if name.len() > 64 {
        name.truncate(64);
    }
    name
}

/// Load tool definitions for every enabled MCP server by actually spawning
/// each server and calling `tools/list`. Servers that fail to start or
/// respond are logged and skipped — they do not block the agent from
/// starting.
pub async fn load_mcp_tool_definitions() -> Vec<ToolDefinition> {
    let server_names = discover_enabled_servers();
    let mut defs: Vec<ToolDefinition> = Vec::new();

    for server in server_names {
        match McpConnectionPool::list_tools_for_server(&server).await {
            Ok(tools) => {
                for t in tools {
                    let description = if t.description.is_empty() {
                        format!("MCP tool '{}' on server '{}'.", t.name, server)
                    } else {
                        t.description.clone()
                    };
                    let parameters = if t.input_schema.is_null() {
                        serde_json::json!({
                            "type": "object",
                            "properties": {},
                            "required": []
                        })
                    } else {
                        t.input_schema.clone()
                    };
                    defs.push(ToolDefinition {
                        name: make_tool_name(&server, &t.name),
                        description,
                        parameters,
                    });
                }
            }
            Err(e) => {
                warn!(server = %server, "Failed to list MCP tools: {}", e);
            }
        }
    }

    defs
}

/// Parse a fully-qualified MCP tool name back into the original server name
/// and tool name. Because `make_tool_name` sanitizes both sides, we cannot
/// always recover the *original* names — instead, we compare sanitized
/// candidates against all enabled servers and their advertised tools.
async fn resolve_mcp_name(name: &str) -> Result<(String, String), String> {
    let rest = name
        .strip_prefix("mcp__")
        .ok_or_else(|| format!("Tool name '{}' does not start with 'mcp__'", name))?;
    let parts: Vec<&str> = rest.splitn(2, "__").collect();
    if parts.len() != 2 {
        return Err(format!("Tool name '{}' is not in mcp__server__tool form", name));
    }
    let server_slug = parts[0];
    let tool_slug = parts[1];

    // Find the matching original server name.
    let servers = discover_enabled_servers();
    let server = servers
        .into_iter()
        .find(|s| sanitize(s) == server_slug)
        .ok_or_else(|| format!("No enabled MCP server matches slug '{}'", server_slug))?;

    // Find the matching original tool name by re-listing tools for the
    // server. The pool caches the connection so this is cheap on the hot
    // path.
    let tools = McpConnectionPool::list_tools_for_server(&server).await?;
    let tool = tools
        .into_iter()
        .find(|t| sanitize(&t.name) == tool_slug)
        .ok_or_else(|| {
            format!(
                "No tool matching slug '{}' on MCP server '{}'",
                tool_slug, server
            )
        })?;

    Ok((server, tool.name))
}

/// Executor for any tool whose name starts with `mcp__`.
pub async fn execute_mcp_tool(
    name: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let (server, tool) = resolve_mcp_name(name).await?;
    McpConnectionPool::call_tool_on_server(&server, &tool, args).await
}
