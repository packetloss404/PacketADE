//! Claude-Code-style sub-agent invocation.
//!
//! Exposes a `spawn_subagent` tool that the main agent can call to delegate a
//! focused, read-only research task to a fresh agent loop. The sub-agent runs
//! synchronously (no Tauri events), executes up to a small number of tool
//! calls against the parent's `ExecutionTarget`, and returns a single summary
//! paragraph.

use crate::core::execution::ExecutionTarget;
use crate::core::llm_provider::get_provider;
use crate::core::llm_types::{
    ChatMessage, ChatRole, ContentBlock, LlmRequest, MessageContent, StreamChunk, ToolCall,
    ToolDefinition,
};
use crate::core::tool_runtime;
use tokio::sync::mpsc;

const MAX_ITERATIONS: usize = 8;

/// Tools a sub-agent may never hold, whatever its definition asks for. The
/// sub-agent loop below has no permission prompt, no plan-mode block, and no
/// pending-edit gate — it dispatches straight into `tool_runtime::execute_tool`
/// — so anything here would run on the model's authority alone, routing
/// around every gate the parent session enforces (`commands::api_agent`).
pub(crate) const SUBAGENT_DENIED_TOOLS: &[&str] =
    &["bash", "write_file", "edit_file", "create_pull_request"];

/// True when a sub-agent may execute `tool_name` given the tool set it was
/// handed. The set is the allowlist; the denied list is a floor beneath it.
pub(crate) fn subagent_tool_permitted(tool_name: &str, tools: &[ToolDefinition]) -> bool {
    !SUBAGENT_DENIED_TOOLS.contains(&tool_name) && tools.iter().any(|t| t.name == tool_name)
}

/// The provider/model of the SESSION whose tool loop is currently executing.
///
/// Q2 — sub-agent tools are agentic helpers, not auxiliary tasks: they derive
/// their provider from the parent session instead of aux routing, so a
/// MiniMax-only (or Ollama-only) user's `spawn_subagent` no longer dies on a
/// missing Anthropic key. `api_agent.rs` opens this scope around each tool
/// dispatch; nested sub-agent chains inherit it because the whole chain is
/// awaited inside the scope.
#[derive(Clone, Debug)]
pub struct ParentLlm {
    pub provider: String,
    pub model: String,
}

tokio::task_local! {
    pub static PARENT_LLM: ParentLlm;
}

/// The ambient parent-session LLM, when a tool loop opened the scope.
pub(crate) fn current_parent_llm() -> Option<ParentLlm> {
    PARENT_LLM.try_with(|parent| parent.clone()).ok()
}

/// Provider + cheap-tier model for a sub-agent turn: the parent session's
/// provider when known (fixes the MiniMax-only-user defect), else the
/// historical Anthropic default.
pub(crate) fn subagent_provider_and_model() -> (String, String) {
    match current_parent_llm() {
        Some(parent) => {
            let model =
                crate::core::aux_llm::cheap_tier_model(&parent.provider, &parent.model);
            (parent.provider, model)
        }
        None => ("anthropic".to_string(), "claude-haiku-4-5".to_string()),
    }
}

const SUBAGENT_SYSTEM_PROMPT: &str = "You are a focused research sub-agent. Use the read-only tools to investigate the task. After 1-3 tool calls, return a concise one-paragraph summary. Do not produce code or recommendations beyond the summary.";

/// Tool definition advertised to the parent agent.
#[allow(dead_code)]
pub fn spawn_subagent_definition() -> ToolDefinition {
    ToolDefinition {
        name: "spawn_subagent".to_string(),
        description: "Run a focused sub-task in a fresh agent context with read-only tools (read_file, list_directory, grep, web_fetch). The sub-agent runs to completion and returns a single summary paragraph. Use for: research questions, codebase exploration, fact-finding. Do NOT use for: making edits, running shell commands.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "One-sentence description of what to find."
                },
                "model": {
                    "type": "string",
                    "description": "Optional model override (currently ignored — sub-agent always uses a fast default)."
                }
            },
            "required": ["task"]
        }),
    }
}

/// Build the read-only tool subset the sub-agent is allowed to call.
async fn read_only_tool_definitions() -> Vec<ToolDefinition> {
    let allowed = ["read_file", "list_directory", "grep", "web_fetch"];
    let mut tools: Vec<ToolDefinition> = tool_runtime::tool_definitions()
        .await
        .into_iter()
        .filter(|t| allowed.contains(&t.name.as_str()))
        .collect();

    // `web_fetch` may not be defined in tool_runtime — provide a minimal
    // definition here so the model can still call it (dispatch will surface
    // an error if the runtime can't service it).
    if !tools.iter().any(|t| t.name == "web_fetch") {
        tools.push(ToolDefinition {
            name: "web_fetch".to_string(),
            description: "Fetch the contents of a URL and return the response body as text."
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch."
                    }
                },
                "required": ["url"]
            }),
        });
    }

    tools
}

/// Drain a `StreamChunk` receiver into (assistant text, tool calls).
pub(crate) async fn collect_response(
    mut rx: mpsc::Receiver<StreamChunk>,
) -> Result<(String, Vec<ToolCall>), String> {
    let mut text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    while let Some(chunk) = rx.recv().await {
        match chunk {
            StreamChunk::TextDelta { text: t } => text.push_str(&t),
            StreamChunk::ToolUseEnd {
                id,
                name,
                arguments,
            } => {
                tool_calls.push(ToolCall {
                    id,
                    name,
                    arguments,
                });
            }
            StreamChunk::Error { message } => return Err(message),
            StreamChunk::Done { .. } => break,
            _ => {}
        }
    }

    Ok((text, tool_calls))
}

/// Shared agentic tool loop for the sub-agent tools (`spawn_subagent` and
/// custom `agent_*` tools). Runs up to `MAX_ITERATIONS` request→tool-dispatch
/// rounds against `provider`, recursing into `tool_runtime::execute_tool` for
/// each tool call (the recursion is boxed at `execute_tool`'s dispatch site),
/// and returns the final assistant text. `empty_error` is returned when the
/// loop finishes without producing any text.
///
/// Callers hold the shared [`SubagentDepthGuard`] across this call so nested
/// sub-agent chains stay bounded.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_agent_loop(
    provider: &dyn crate::core::llm_provider::LlmProvider,
    api_key: &str,
    model: String,
    system_prompt: String,
    tools: Vec<ToolDefinition>,
    max_tokens: u32,
    task: String,
    parent_target: &ExecutionTarget,
    empty_error: &str,
) -> Result<String, String> {
    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(task),
    }];

    let mut final_text = String::new();

    for _ in 0..MAX_ITERATIONS {
        let request = LlmRequest {
            model: model.clone(),
            messages: messages.clone(),
            tools: tools.clone(),
            system_prompt: Some(system_prompt.clone()),
            max_tokens,
            temperature: None,
            attachments: Vec::new(),
            thinking_enabled: false,
            thinking_budget_tokens: 0,
            cache_key: None,
        };

        let (tx, rx) = mpsc::channel::<StreamChunk>(64);
        let stream_fut = provider.stream_chat(api_key, request, tx);
        let collect_fut = collect_response(rx);

        let (stream_res, collected) = tokio::join!(stream_fut, collect_fut);
        stream_res?;
        let (assistant_text, tool_calls) = collected?;

        // Build the assistant turn (text + tool_use blocks) for history.
        let mut blocks: Vec<ContentBlock> = Vec::new();
        if !assistant_text.is_empty() {
            blocks.push(ContentBlock::Text {
                text: assistant_text.clone(),
            });
        }
        for call in &tool_calls {
            blocks.push(ContentBlock::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            });
        }

        if tool_calls.is_empty() {
            // No tool calls => model's final answer.
            final_text = assistant_text;
            break;
        }

        messages.push(ChatMessage {
            role: ChatRole::Assistant,
            content: MessageContent::Blocks(blocks),
        });

        // Dispatch each tool call and collect results into a single tool message.
        let mut result_blocks: Vec<ContentBlock> = Vec::with_capacity(tool_calls.len());
        for call in tool_calls {
            // The tool list handed to the model is the allowlist; a call
            // outside it (or to a denied tool) is refused, never executed.
            // Without this the list was advisory — the model could name
            // `bash` and this loop would run it with no gate at all.
            // Recurses into execute_tool — the future is boxed at that dispatch.
            let result = if subagent_tool_permitted(&call.name, &tools) {
                tool_runtime::execute_tool(&call, parent_target).await
            } else {
                tracing::warn!(
                    target: "packetbench::auth",
                    tool = %call.name,
                    "sub-agent requested a tool outside its allowlist; refused"
                );
                crate::core::llm_types::ToolResult {
                    tool_call_id: call.id.clone(),
                    content: format!(
                        "Error: tool '{}' is not available to this sub-agent.",
                        call.name
                    ),
                    is_error: true,
                }
            };
            result_blocks.push(ContentBlock::ToolResult {
                tool_call_id: result.tool_call_id,
                content: result.content,
                is_error: result.is_error,
            });
        }
        messages.push(ChatMessage {
            role: ChatRole::Tool,
            content: MessageContent::Blocks(result_blocks),
        });

        // Carry partial text forward so we still have something to return if
        // the loop terminates early via the iteration cap.
        if !assistant_text.is_empty() {
            final_text = assistant_text;
        }
    }

    if final_text.trim().is_empty() {
        Err(empty_error.to_string())
    } else {
        Ok(final_text)
    }
}

/// Shared recursion-depth guard for sub-agent tools (spawn_subagent +
/// custom agents). Prevents an agent's prompt from triggering an
/// unbounded chain of sub-agent calls that would burn tokens and
/// eventually fail. 3 levels is more than any sane workflow needs.
pub(crate) static SUBAGENT_DEPTH: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
pub(crate) const MAX_SUBAGENT_DEPTH: usize = 3;

/// RAII guard that increments SUBAGENT_DEPTH on construction and
/// decrements on drop. Returns Err when the cap would be exceeded.
#[derive(Debug)]
pub(crate) struct SubagentDepthGuard;

impl SubagentDepthGuard {
    pub(crate) fn acquire() -> Result<Self, String> {
        use std::sync::atomic::Ordering;
        let prev = SUBAGENT_DEPTH.fetch_add(1, Ordering::SeqCst);
        if prev >= MAX_SUBAGENT_DEPTH {
            SUBAGENT_DEPTH.fetch_sub(1, Ordering::SeqCst);
            return Err(format!(
                "Sub-agent recursion depth ({}) exceeded — refusing to spawn another nested sub-agent.",
                MAX_SUBAGENT_DEPTH
            ));
        }
        Ok(Self)
    }
}

impl Drop for SubagentDepthGuard {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        SUBAGENT_DEPTH.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Tool entry-point invoked from `tool_runtime::execute_tool`.
#[allow(dead_code)]
pub async fn execute_spawn_subagent(
    args: &serde_json::Value,
    parent_target: &ExecutionTarget,
) -> Result<String, String> {
    let _depth_guard = SubagentDepthGuard::acquire()?;

    let task = args
        .get("task")
        .and_then(|t| t.as_str())
        .ok_or("Missing 'task' parameter")?
        .to_string();

    // Q2: run on the PARENT session's provider at its cheap tier — never on
    // a hardcoded vendor the user may have no key for.
    let (provider_id, model) = subagent_provider_and_model();
    let api_key = crate::commands::api_keys::load_api_key(&provider_id)
        .map_err(|e| format!("spawn_subagent requires a {} API key: {}", provider_id, e))?;

    let provider = get_provider(&provider_id)?;
    let tools = read_only_tool_definitions().await;

    // `_depth_guard` (acquired above) stays alive across the whole loop.
    run_agent_loop(
        &*provider,
        &api_key,
        model,
        SUBAGENT_SYSTEM_PROMPT.to_string(),
        tools,
        2048,
        task,
        parent_target,
        "Sub-agent finished without producing a summary",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            parameters: serde_json::json!({ "type": "object" }),
        }
    }

    #[test]
    fn subagent_allowlist_is_enforced_not_advisory() {
        let tools = vec![def("read_file"), def("grep")];
        assert!(subagent_tool_permitted("read_file", &tools));
        assert!(!subagent_tool_permitted("write_file", &tools), "not in list");
        assert!(!subagent_tool_permitted("bash", &tools), "not in list");
        assert!(
            !subagent_tool_permitted("mcp__x__read", &tools),
            "unknown tools are refused"
        );
    }

    #[test]
    fn denied_tools_stay_denied_even_when_listed() {
        // A custom agent definition (possibly repo-supplied) can ask for
        // `bash`; the floor refuses it regardless of the list.
        let tools = vec![def("bash"), def("create_pull_request"), def("read_file")];
        for denied in SUBAGENT_DENIED_TOOLS {
            assert!(
                !subagent_tool_permitted(denied, &tools),
                "{denied} must be refused"
            );
        }
        assert!(subagent_tool_permitted("read_file", &tools));
    }

    /// Proves that SubagentDepthGuard refuses to spawn beyond
    /// MAX_SUBAGENT_DEPTH and recovers the counter via Drop.
    #[test]
    fn depth_guard_caps_at_max_and_releases_on_drop() {
        use std::sync::atomic::Ordering;
        // Make sure we start clean even if other tests ran first.
        SUBAGENT_DEPTH.store(0, Ordering::SeqCst);

        let g1 = SubagentDepthGuard::acquire().expect("depth 1 should acquire");
        let g2 = SubagentDepthGuard::acquire().expect("depth 2 should acquire");
        let g3 = SubagentDepthGuard::acquire().expect("depth 3 should acquire");
        let err = SubagentDepthGuard::acquire().expect_err("depth 4 should refuse");
        assert!(err.contains("recursion depth"));
        assert_eq!(SUBAGENT_DEPTH.load(Ordering::SeqCst), MAX_SUBAGENT_DEPTH);

        drop(g3);
        assert_eq!(SUBAGENT_DEPTH.load(Ordering::SeqCst), 2);
        drop(g2);
        drop(g1);
        assert_eq!(SUBAGENT_DEPTH.load(Ordering::SeqCst), 0);
    }
}
