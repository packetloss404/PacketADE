//! Anthropic Messages API provider.

use crate::core::llm_provider::{delimit_final_sse_line, LlmProvider};
use crate::core::llm_types::*;
use futures::StreamExt;
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use tokio::sync::mpsc;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider;

/// Convert our messages to Anthropic format (system prompt is separate, tool results use specific format).
/// If `attachments` is non-empty, inline them into the LAST ChatRole::User message as image blocks.
fn build_anthropic_messages(
    messages: &[ChatMessage],
    attachments: &[ImageAttachment],
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();

    // Find the index of the last ChatRole::User message so we can attach images to it.
    let last_user_idx = messages
        .iter()
        .rposition(|m| matches!(m.role, ChatRole::User));

    for (idx, msg) in messages.iter().enumerate() {
        match &msg.role {
            ChatRole::User => {
                let is_last_user = Some(idx) == last_user_idx;
                if is_last_user && !attachments.is_empty() {
                    let mut content_blocks: Vec<serde_json::Value> = attachments
                        .iter()
                        .map(|a| {
                            serde_json::json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": a.media_type,
                                    "data": a.data_base64,
                                },
                            })
                        })
                        .collect();
                    content_blocks.push(serde_json::json!({
                        "type": "text",
                        "text": msg.content.as_text(),
                    }));
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": content_blocks,
                    }));
                } else {
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": msg.content.as_text(),
                    }));
                }
            }
            ChatRole::Assistant => match &msg.content {
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
                            ContentBlock::ToolUse {
                                id,
                                name,
                                arguments,
                            } => Some(serde_json::json!({
                                "type": "tool_use",
                                "id": id,
                                "name": name,
                                "input": arguments,
                            })),
                            _ => None,
                        })
                        .collect();
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": content_blocks,
                    }));
                }
            },
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

        let messages = build_anthropic_messages(&request.messages, &request.attachments);
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
        if request.thinking_enabled {
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": request.thinking_budget_tokens,
            });
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
            return Err(format!("Anthropic API error ({}): {}", status, body_text));
        }

        let mut stream = response.bytes_stream();
        // F46: buffer raw bytes rather than lossy-decoding each chunk. A multibyte
        // UTF-8 char split across two chunks would otherwise be mangled into U+FFFD
        // by a per-chunk from_utf8_lossy. SSE lines are '\n'-terminated (an ASCII
        // byte that cannot occur mid-codepoint), so a complete line is always a
        // complete UTF-8 sequence; we only decode once a full line is buffered.
        let mut buffer: Vec<u8> = Vec::new();
        let mut current_tool_id = String::new();
        let mut current_tool_name = String::new();
        let mut current_tool_args = String::new();
        let mut current_block_type: &str = "";
        let mut input_tokens: u64 = 0;
        let mut output_tokens: u64 = 0;
        let mut cache_read_input_tokens: u64 = 0;
        let mut cache_creation_input_tokens: u64 = 0;

        let mut stream_ended = false;
        loop {
            // RA1: if the consumer dropped the receiver, stop parsing the rest of
            // the upstream HTTP stream instead of draining it into a dead channel.
            if tx.is_closed() {
                return Ok(());
            }
            if !stream_ended {
                match stream.next().await {
                    Some(chunk_result) => {
                        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
                        buffer.extend_from_slice(&chunk);
                    }
                    None => {
                        stream_ended = true;
                        // SSE permits the final record at EOF without a trailing
                        // newline. Add a parser delimiter so it follows the exact
                        // same path as every other complete line.
                        delimit_final_sse_line(&mut buffer);
                    }
                }
            }

            while let Some(line_end) = buffer.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = buffer.drain(..=line_end).collect();
                let line = String::from_utf8_lossy(&line_bytes).trim().to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                // Anthropic uses "event: <type>" lines followed by "data: <json>"
                if line.starts_with("event:") {
                    continue; // We parse the data lines directly
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let event_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

                        match event_type {
                            "message_start" => {
                                if let Some(usage) =
                                    parsed.get("message").and_then(|m| m.get("usage"))
                                {
                                    input_tokens = usage
                                        .get("input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                    cache_read_input_tokens = usage
                                        .get("cache_read_input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                    cache_creation_input_tokens = usage
                                        .get("cache_creation_input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0);
                                }
                            }
                            "content_block_start" => {
                                if let Some(cb) = parsed.get("content_block") {
                                    let cb_type =
                                        cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                    if cb_type == "tool_use" {
                                        current_block_type = "tool_use";
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
                                    } else if cb_type == "thinking" {
                                        current_block_type = "thinking";
                                    } else if cb_type == "text" {
                                        current_block_type = "text";
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
                                            if let Some(partial) =
                                                delta.get("partial_json").and_then(|p| p.as_str())
                                            {
                                                current_tool_args.push_str(partial);
                                                let _ = tx
                                                    .send(StreamChunk::ToolUseInputDelta {
                                                        delta: partial.to_string(),
                                                    })
                                                    .await;
                                            }
                                        }
                                        "thinking_delta" => {
                                            if let Some(text) =
                                                delta.get("thinking").and_then(|t| t.as_str())
                                            {
                                                let _ = tx
                                                    .send(StreamChunk::ThinkingDelta {
                                                        text: text.to_string(),
                                                    })
                                                    .await;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            "content_block_stop" => {
                                if current_block_type == "tool_use" && !current_tool_id.is_empty() {
                                    let args = serde_json::from_str(&current_tool_args)
                                        .unwrap_or_else(|e| {
                                            tracing::warn!(error = %e, tool = %current_tool_name, "malformed tool-arg JSON from stream; coercing to empty object");
                                            serde_json::Value::Object(serde_json::Map::new())
                                        });
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
                                } else if current_block_type == "thinking" {
                                    let _ = tx.send(StreamChunk::ThinkingStop).await;
                                }
                                current_block_type = "";
                            }
                            "message_delta" => {
                                if let Some(usage) = parsed.get("usage") {
                                    output_tokens = usage
                                        .get("output_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(output_tokens);
                                    cache_read_input_tokens = usage
                                        .get("cache_read_input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(cache_read_input_tokens);
                                    cache_creation_input_tokens = usage
                                        .get("cache_creation_input_tokens")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(cache_creation_input_tokens);
                                }
                            }
                            "message_stop" => {
                                let _ = tx
                                    .send(StreamChunk::Done {
                                        input_tokens,
                                        output_tokens,
                                        cache_read_input_tokens,
                                        cache_creation_input_tokens,
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
                                return Err(msg.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            }

            if stream_ended {
                break;
            }
        }

        // Stream ended without message_stop
        let _ = tx
            .send(StreamChunk::Done {
                input_tokens,
                output_tokens,
                cache_read_input_tokens,
                cache_creation_input_tokens,
            })
            .await;
        Ok(())
    }

    fn provider_id(&self) -> &str {
        "anthropic"
    }
}
