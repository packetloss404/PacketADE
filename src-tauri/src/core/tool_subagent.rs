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

const SUBAGENT_MODEL: &str = "claude-haiku-4-5";
const MAX_ITERATIONS: usize = 8;

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
            description: "Fetch the contents of a URL and return the response body as text.".to_string(),
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
async fn collect_response(
    mut rx: mpsc::Receiver<StreamChunk>,
) -> Result<(String, Vec<ToolCall>), String> {
    let mut text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    while let Some(chunk) = rx.recv().await {
        match chunk {
            StreamChunk::TextDelta { text: t } => text.push_str(&t),
            StreamChunk::ToolUseEnd { id, name, arguments } => {
                tool_calls.push(ToolCall { id, name, arguments });
            }
            StreamChunk::Error { message } => return Err(message),
            StreamChunk::Done { .. } => break,
            _ => {}
        }
    }

    Ok((text, tool_calls))
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

    let api_key = crate::commands::api_keys::load_api_key("anthropic")
        .map_err(|e| format!("spawn_subagent requires an Anthropic API key: {}", e))?;

    let provider = get_provider("anthropic")?;
    let tools = read_only_tool_definitions().await;

    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: ChatRole::User,
        content: MessageContent::text(task),
    }];

    let mut final_text = String::new();

    for _ in 0..MAX_ITERATIONS {
        let request = LlmRequest {
            model: SUBAGENT_MODEL.to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
            system_prompt: Some(SUBAGENT_SYSTEM_PROMPT.to_string()),
            max_tokens: 2048,
            temperature: None,
            attachments: Vec::new(),
            thinking_enabled: false,
            thinking_budget_tokens: 0,
        };

        let (tx, rx) = mpsc::channel::<StreamChunk>(64);
        let provider_ref = &*provider;
        let stream_fut = provider_ref.stream_chat(&api_key, request, tx);
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
            // No tool calls => model's final answer (Anthropic stop_reason=end_turn equivalent).
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
            let result = tool_runtime::execute_tool(&call, parent_target).await;
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
        Err("Sub-agent finished without producing a summary".to_string())
    } else {
        Ok(final_text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let err = SubagentDepthGuard::acquire()
            .expect_err("depth 4 should refuse");
        assert!(err.contains("recursion depth"));
        assert_eq!(SUBAGENT_DEPTH.load(Ordering::SeqCst), MAX_SUBAGENT_DEPTH);

        drop(g3);
        assert_eq!(SUBAGENT_DEPTH.load(Ordering::SeqCst), 2);
        drop(g2);
        drop(g1);
        assert_eq!(SUBAGENT_DEPTH.load(Ordering::SeqCst), 0);
    }
}
