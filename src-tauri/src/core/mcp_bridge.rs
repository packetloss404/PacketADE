//! Bridge between user-configured MCP servers and the API agent's tool list.
//!
//! Discovers tools by spawning each enabled MCP server (via `McpConnectionPool`)
//! and calling `tools/list`. Each discovered tool becomes a `ToolDefinition`
//! named with a sanitized `mcp__<server>__<tool>` prefix and a stable hash
//! suffix when needed so it conforms to provider tool-name regex
//! (`^[A-Za-z0-9_-]{1,64}$`) without losing the original server/tool mapping.
//!
//! Execution is dispatched in `tool_runtime::execute_tool` via the
//! `mcp__*` arm, which calls back into `execute_mcp_tool` here.

use crate::core::llm_types::ToolDefinition;
use crate::core::mcp_client::McpConnectionPool;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tracing::warn;

const MAX_PROVIDER_TOOL_NAME_LEN: usize = 64;
const MCP_TOOL_PREFIX: &str = "mcp__";
const HASH_SUFFIX_LEN: usize = 12;

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

fn server_allowed(name: &str, filter: Option<&[String]>) -> bool {
    filter
        .map(|allowed| allowed.iter().any(|candidate| candidate == name))
        .unwrap_or(true)
}

/// Read the user's global MCP server config and return enabled server names.
fn discover_enabled_servers(filter: Option<&[String]>) -> Vec<String> {
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
            if !server_allowed(name, filter) {
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

fn stable_name_hash(server: &str, tool: &str) -> String {
    // FNV-1a 64-bit: tiny, deterministic, and plenty for provider-name suffixes.
    let mut hash = 0xcbf29ce484222325_u64;
    for b in server
        .as_bytes()
        .iter()
        .chain([0xff_u8].iter())
        .chain(tool.as_bytes().iter())
    {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn truncate_ascii(s: &str, max_len: usize) -> &str {
    &s[..s.len().min(max_len)]
}

/// Build the canonical agent-facing tool name for a (server, tool) pair.
fn make_tool_name(server: &str, tool: &str) -> String {
    let server_slug = sanitize(server);
    let tool_slug = sanitize(tool);
    let simple = format!("{MCP_TOOL_PREFIX}{server_slug}__{tool_slug}");
    if simple.len() <= MAX_PROVIDER_TOOL_NAME_LEN && server_slug == server && tool_slug == tool {
        return simple;
    }

    let hash = &stable_name_hash(server, tool)[..HASH_SUFFIX_LEN];
    let fixed_len = MCP_TOOL_PREFIX.len() + "__".len() + "_".len() + HASH_SUFFIX_LEN;
    let budget = MAX_PROVIDER_TOOL_NAME_LEN.saturating_sub(fixed_len);
    let mut server_budget = server_slug.len().min(budget / 2);
    let mut tool_budget = tool_slug.len().min(budget - server_budget);

    let unused_tool_budget = budget - server_budget - tool_budget;
    if unused_tool_budget > 0 && server_budget < server_slug.len() {
        let extra = (server_slug.len() - server_budget).min(unused_tool_budget);
        server_budget += extra;
    }

    let unused_server_budget = budget - server_budget - tool_budget;
    if unused_server_budget > 0 && tool_budget < tool_slug.len() {
        let extra = (tool_slug.len() - tool_budget).min(unused_server_budget);
        tool_budget += extra;
    }

    format!(
        "{MCP_TOOL_PREFIX}{}__{}_{}",
        truncate_ascii(&server_slug, server_budget),
        truncate_ascii(&tool_slug, tool_budget),
        hash
    )
}

/// Load tool definitions for every enabled MCP server by actually spawning
/// each server and calling `tools/list`. Servers that fail to start or
/// respond are logged and skipped — they do not block the agent from
/// starting.
pub async fn load_mcp_tool_definitions(
    enabled_server_ids: Option<&[String]>,
) -> Vec<ToolDefinition> {
    let server_names = discover_enabled_servers(enabled_server_ids);
    let mut defs: Vec<ToolDefinition> = Vec::new();
    let mut advertised_names: HashMap<String, (String, String)> = HashMap::new();

    for server in server_names {
        match McpConnectionPool::list_tools_for_server(&server).await {
            Ok(tools) => {
                for t in tools {
                    let advertised_name = make_tool_name(&server, &t.name);
                    if let Some((other_server, other_tool)) = advertised_names.get(&advertised_name)
                    {
                        warn!(
                            server = %server,
                            tool = %t.name,
                            other_server = %other_server,
                            other_tool = %other_tool,
                            advertised_name = %advertised_name,
                            "Skipping MCP tool with colliding advertised name"
                        );
                        continue;
                    }
                    advertised_names
                        .insert(advertised_name.clone(), (server.clone(), t.name.clone()));
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
                        name: advertised_name,
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

/// Resolve an agent-facing MCP tool name back into the original server/tool
/// pair. This compares against generated advertisements instead of reversing
/// slugs, so long names and sanitized names round-trip correctly.
async fn resolve_mcp_name(
    name: &str,
    enabled_server_ids: Option<&[String]>,
) -> Result<(String, String), String> {
    if !name.starts_with(MCP_TOOL_PREFIX) {
        return Err(format!("Tool name '{}' does not start with 'mcp__'", name));
    }

    let mut matches = Vec::new();
    for server in discover_enabled_servers(enabled_server_ids) {
        let tools = McpConnectionPool::list_tools_for_server(&server).await?;
        for tool in tools {
            if make_tool_name(&server, &tool.name) == name {
                matches.push((server.clone(), tool.name));
            }
        }
    }

    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!(
            "No enabled MCP tool matches advertised name '{}'",
            name
        )),
        _ => Err(format!(
            "MCP tool name '{}' is ambiguous across enabled servers",
            name
        )),
    }
}

/// Executor for any tool whose name starts with `mcp__`.
pub async fn execute_mcp_tool(
    name: &str,
    args: &serde_json::Value,
    enabled_server_ids: Option<&[String]>,
) -> Result<String, String> {
    let (server, tool) = resolve_mcp_name(name, enabled_server_ids).await?;
    McpConnectionPool::call_tool_on_server(&server, &tool, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_mcp_tool_names_fit_provider_limit_and_keep_hash() {
        let name = make_tool_name(
            "very-long-server-name-that-would-overflow-provider-tool-name-limits",
            "very-long-tool-name-that-also-would-overflow-provider-tool-name-limits",
        );
        assert!(name.len() <= MAX_PROVIDER_TOOL_NAME_LEN);
        assert!(name.starts_with("mcp__"));
        assert_eq!(name.rsplit('_').next().unwrap().len(), HASH_SUFFIX_LEN);
    }

    #[test]
    fn sanitized_names_get_hash_suffix_to_avoid_collisions() {
        let dotted = make_tool_name("server.name", "tool.name");
        let underscored = make_tool_name("server_name", "tool_name");
        assert_ne!(dotted, underscored);
        assert!(dotted.len() <= MAX_PROVIDER_TOOL_NAME_LEN);
    }

    #[test]
    fn simple_names_stay_readable() {
        assert_eq!(make_tool_name("github", "search"), "mcp__github__search");
    }
}
