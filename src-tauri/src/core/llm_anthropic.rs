//! Anthropic Messages API provider.

use crate::core::llm_types::*;
use crate::core::llm_provider::LlmProvider;
use futures::StreamExt;
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use tokio::sync::mpsc;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider;

/// Convert our messages to Anthropic format (system prompt is separate, tool results use specific format).
fn build_anthropic_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();

    for msg in messages {
        match &msg.role {
            ChatRole::User => {
                out.push(serde_json::json!({
                    "role": "user",
                    "content": msg.content.as_text(),
                }));
            }
            ChatRole::Assistant => {
                match &msg.content {
                    MessageContent::Text(text) => {
                        out.push(serde_json::json!({
                            "role": "assistant",
                            "content": text,
                        }));
                    }
                    MessageContent::Blocks(blocks) => {
                        let content_blocks: Vec<serde_json::Value> = blocks
                            .iter()
                            .filter_map(|b| match b {
                                ContentBlock::Text { text } => Some(serde_json::json!({
                                    "type": "text",
                                    "text": text,
                                })),
                                ContentBlock::ToolUse { id, name, arguments } => {
                                    Some(serde_json::json!({
                                        "type": "tool_use",
                                        "id": id,
                                        "name": name,
                                        "input": arguments,
                                    }))
                                }
                                _ => None,
                            })
                            .collect();
                        out.push(serde_json::json!({
                            "role": "assistant",
                            "content": content_blocks,
                        }));
                    }
                }
            }
            ChatRole::Tool => {
                // Anthropic uses role "user" with tool_result content blocks
                if let MessageContent::Blocks(blocks) = &msg.content {
                    let content_blocks: Vec<serde_json::Value> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolResult {
                                tool_call_id,
                                content,
                                is_error,
                            } => Some(serde_json::json!({
                                "type": "tool_result",
                                "tool_use_id": tool_call_id,
                                "content": content,
                                "is_error": is_error,
                            })),
                            _ => None,
                        })
                        .collect();
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": content_blocks,
                    }));
                }
            }
            ChatRole::System => {
                // System messages should be passed via the system parameter, not here
            }
        }
    }
    out
}

fn build_anthropic_tools(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            })
        })
        .collect()
}

#[async_trait::async_trait]
impl LlmProvider for AnthropicProvider {
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        let client = reqwest::Client::new();

        let messages = build_anthropic_messages(&request.messages);
        let tools = build_anthropic_tools(&request.tools);

        let mut body = serde_json::json!({
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "stream": true,
        });

        if let Some(ref sp) = request.system_prompt {
            body["system"] = serde_json::json!(sp);
        }
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools);
        }
        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }

        let response = client
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Anthropic request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read response".to_string());
            let _ = tx
                .send(StreamChunk::Error {
                    message: format!("Anthropic API error ({}): {}", status, body_text),
                })
                .await;
            return Err(format!("Anthropic API error ({}): {}", status, body_text));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut current_tool_id = String::new();
        let mut current_tool_name = String::new();
        let mut current_tool_args = String::new();
        let mut input_tokens: u64 = 0;
        let mut output_tokens: u64 = 0;

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim().to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                // Anthropic uses "event: <type>" lines followed by "data: <json>"
                if line.starts_with("event:") {
                    continue; // We parse the data lines directly
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let event_type = parsed
                            .get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");

                        match event_type {
                            "message_start" => {
                                if let Some(usage) = parsed
                                    .get("message")
                                    .and_then(|m| m.get("usage"))
                                {
                                    input_tokens = usage
                                        .get("input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                }
                            }
                            "content_block_start" => {
                                if let Some(cb) = parsed.get("content_block") {
                                    let cb_type =
                                        cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    if cb_type == "tool_use" {
                                        current_tool_id = cb
                                            .get("id")
                                            .and_then(|id| id.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        current_tool_name = cb
                                            .get("name")
                                            .and_then(|n| n.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        current_tool_args.clear();
                                        let _ = tx
                                            .send(StreamChunk::ToolUseStart {
                                                id: current_tool_id.clone(),
                                                name: current_tool_name.clone(),
                                            })
                                            .await;
                                    }
                                }
                            }
                            "content_block_delta" => {
                                if let Some(delta) = parsed.get("delta") {
                                    let delta_type =
                                        delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    match delta_type {
                                        "text_delta" => {
                                            if let Some(text) =
                                                delta.get("text").and_then(|t| t.as_str())
                                            {
                                                let _ = tx
                                                    .send(StreamChunk::TextDelta {
                                                        text: text.to_string(),
                                                    })
                                                    .await;
                                            }
                                        }
                                        "input_json_delta" => {
                                            if let Some(partial) = delta
                                                .get("partial_json")
                                                .and_then(|p| p.as_str())
                                            {
                                                current_tool_args.push_str(partial);
                                                let _ = tx
                                                    .send(StreamChunk::ToolUseInputDelta {
                                                        delta: partial.to_string(),
                                                    })
                                                    .await;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            "content_block_stop" => {
                                if !current_tool_id.is_empty() {
                                    let args = serde_json::from_str(&current_tool_args)
                                        .unwrap_or(serde_json::Value::Object(
                                            serde_json::Map::new(),
                                        ));
                                    let _ = tx
                                        .send(StreamChunk::ToolUseEnd {
                                            id: current_tool_id.clone(),
                                            name: current_tool_name.clone(),
                                            arguments: args,
                                        })
                                        .await;
                                    current_tool_id.clear();
                                    current_tool_name.clear();
                                    current_tool_args.clear();
                                }
                            }
                            "message_delta" => {
                                if let Some(usage) = parsed.get("usage") {
                                    output_tokens = usage
                                        .get("output_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(output_tokens);
                                }
                            }
                            "message_stop" => {
                                let _ = tx
                                    .send(StreamChunk::Done {
                                        input_tokens,
                                        output_tokens,
                                    })
                                    .await;
                                return Ok(());
                            }
                            "error" => {
                                let msg = parsed
                                    .get("error")
                                    .and_then(|e| e.get("message"))
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown error");
                                let _ = tx
                                    .send(StreamChunk::Error {
                                        message: msg.to_string(),
                                    })
                                    .await;
                                return Err(msg.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            }
        }

        // Stream ended without message_stop
        let _ = tx
            .send(StreamChunk::Done {
                input_tokens,
                output_tokens,
            })
            .await;
        Ok(())
    }

    fn provider_id(&self) -> &str {
        "anthropic"
    }
}
