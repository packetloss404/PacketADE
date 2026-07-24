//! Claude-Code-style custom sub-agent dispatcher.
//!
//! Each custom agent file (`<home>/.claude/agents/<name>.md` or
//! `<project>/.claude/agents/<name>.md`) is exposed as a single tool named
//! `agent_<sanitized_name>` that the main agent can call. Invocation spins
//! up a sub-agent loop with the agent's own system prompt, model, and
//! allowed tool subset.

use crate::commands::custom_agents::{discover_custom_agents, CustomAgentDef};
use crate::core::execution::ExecutionTarget;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::ToolDefinition;
use crate::core::tool_runtime;

const DEFAULT_MODEL: &str = "claude-haiku-4-5";
const MAX_ITERATIONS: usize = 8;
const TOOL_PREFIX: &str = "agent_";

/// Default tool allowlist when an agent's frontmatter `tools` array is
/// empty or omitted — mirrors the read-only set used by `spawn_subagent`.
const DEFAULT_READ_ONLY_TOOLS: &[&str] = &["read_file", "list_directory", "grep", "web_fetch"];

/// Sanitize an agent name into a tool-name suffix: lowercase ASCII alnum,
/// other characters become underscores, collapsed runs.
fn sanitize_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_underscore = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_underscore = false;
        } else if !last_underscore && !out.is_empty() {
            out.push('_');
            last_underscore = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    out
}

/// Discover custom agents at startup (home directory only — project agents
/// are re-discovered at invocation time using the parent's project path).
#[allow(dead_code)]
pub fn load_custom_agent_definitions() -> Vec<ToolDefinition> {
    let agents = discover_custom_agents("");
    agents
        .into_iter()
        .filter_map(|a| {
            let suffix = sanitize_name(&a.name);
            if suffix.is_empty() {
                return None;
            }
            Some(ToolDefinition {
                name: format!("{}{}", TOOL_PREFIX, suffix),
                description: a.description.clone(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "What you want this sub-agent to do."
                        }
                    },
                    "required": ["task"]
                }),
            })
        })
        .collect()
}

fn find_agent(tool_name: &str, project_path: &str) -> Option<CustomAgentDef> {
    let suffix = tool_name.strip_prefix(TOOL_PREFIX)?;
    let agents = discover_custom_agents(project_path);
    agents
        .into_iter()
        .find(|a| sanitize_name(&a.name) == suffix)
}

/// Build the tool subset this agent is allowed to call. Empty `allowed_tools`
/// falls back to the read-only default set.
async fn build_allowed_tools(agent: &CustomAgentDef) -> Vec<ToolDefinition> {
    let allowed: Vec<String> = if agent.allowed_tools.is_empty() {
        DEFAULT_READ_ONLY_TOOLS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        agent.allowed_tools.clone()
    };

    let mut tools: Vec<ToolDefinition> = tool_runtime::tool_definitions()
        .await
        .into_iter()
        .filter(|t| allowed.iter().any(|name| name == &t.name))
        .collect();

    // `web_fetch` may not be defined in tool_runtime — provide a minimal
    // fallback so the model can still call it when listed.
    if allowed.iter().any(|n| n == "web_fetch") && !tools.iter().any(|t| t.name == "web_fetch") {
        tools.push(ToolDefinition {
            name: "web_fetch".to_string(),
            description: "Fetch the contents of a URL and return the response body as text."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The URL to fetch." }
                },
                "required": ["url"]
            }),
        });
    }

    tools
}

/// Tool entry-point for `agent_*` invocations dispatched from `tool_runtime::execute_tool`.
#[allow(dead_code)]
pub async fn execute_custom_agent(
    name: &str,
    args: &serde_json::Value,
    parent_target: &ExecutionTarget,
) -> Result<String, String> {
    // Share the sub-agent recursion-depth counter with spawn_subagent so a
    // malicious prompt can't chain `agent_a -> agent_a -> agent_a` beyond
    // MAX_SUBAGENT_DEPTH.
    let _depth_guard = crate::core::tool_subagent::SubagentDepthGuard::acquire()?;

    let task = args
        .get("task")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task' parameter")?
        .to_string();

    let project_path = match parent_target {
        ExecutionTarget::Local { project_path } => project_path.clone(),
        // Custom agents run local-only today: an SSH parent target has no local
        // project path, so we degrade to an empty path (home-dir agents only).
        // Documented rather than silently misleading — remote custom-agent
        // execution isn't wired.
        ExecutionTarget::Ssh { .. } => String::new(),
    };

    let agent = find_agent(name, &project_path)
        .ok_or_else(|| format!("Custom agent not found for tool '{}'", name))?;

    let api_key = crate::commands::api_keys::load_api_key("anthropic")
        .map_err(|e| format!("Custom agent requires an Anthropic API key: {}", e))?;

    let provider = get_provider("anthropic")?;
    let tools = build_allowed_tools(&agent).await;
    let model = agent
        .model
        .as_ref()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    // `_depth_guard` (acquired above) stays alive across the whole loop.
    crate::core::tool_subagent::run_agent_loop(
        &*provider,
        &api_key,
        model,
        agent.system_prompt.clone(),
        tools,
        4096,
        task,
        parent_target,
        "Custom agent finished without producing output",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_basic() {
        assert_eq!(sanitize_name("code-reviewer"), "code_reviewer");
        assert_eq!(sanitize_name("Doc Writer"), "doc_writer");
        assert_eq!(sanitize_name("test--agent--"), "test_agent");
        assert_eq!(sanitize_name("API Surface 2"), "api_surface_2");
    }
}
