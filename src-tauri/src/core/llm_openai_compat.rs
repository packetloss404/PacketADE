//! Shared OpenAI-compatible chat completions implementation.
//!
//! Used by OpenAI, MiniMax, OpenRouter, and Ollama providers.

use crate::core::llm_types::*;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use tokio::sync::mpsc;

/// Configuration for an OpenAI-compatible endpoint.
pub struct OpenAiCompatConfig {
    pub base_url: String,
    pub headers: HeaderMap,
    pub provider_id: String,
}

/// Convert our internal messages to the OpenAI chat format.
/// If `attachments` is non-empty, inline them into the LAST ChatRole::User message as image_url blocks.
fn build_openai_messages(
    messages: &[ChatMessage],
    system_prompt: Option<&str>,
    attachments: &[ImageAttachment],
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();

    if let Some(sp) = system_prompt {
        out.push(serde_json::json!({
            "role": "system",
            "content": sp,
        }));
    }

    let last_user_idx = messages
        .iter()
        .rposition(|m| matches!(m.role, ChatRole::User));

    for (idx, msg) in messages.iter().enumerate() {
        match &msg.role {
            ChatRole::User => {
                let is_last_user = Some(idx) == last_user_idx;
                if is_last_user && !attachments.is_empty() {
                    let mut parts: Vec<serde_json::Value> = vec![serde_json::json!({
                        "type": "text",
                        "text": msg.content.as_text(),
                    })];
                    for a in attachments {
                        parts.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", a.media_type, a.data_base64),
                            },
                        }));
                    }
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": parts,
                    }));
                } else {
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": msg.content.as_text(),
                    }));
                }
            }
            ChatRole::Assistant => {
                // Check if content has tool call blocks
                if let MessageContent::Blocks(blocks) = &msg.content {
                    let mut text_parts = Vec::new();
                    let mut tool_calls = Vec::new();
                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } => text_parts.push(text.clone()),
                            ContentBlock::ToolUse {
                                id,
                                name,
                                arguments,
                            } => {
                                tool_calls.push(serde_json::json!({
                                    "id": id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": arguments.to_string(),
                                    },
                                }));
                            }
                            _ => {}
                        }
                    }
                    let mut entry = serde_json::json!({ "role": "assistant" });
                    if !text_parts.is_empty() {
                        entry["content"] = serde_json::Value::String(text_parts.join("\n"));
                    } else {
                        entry["content"] = serde_json::Value::Null;
                    }
                    if !tool_calls.is_empty() {
                        entry["tool_calls"] = serde_json::Value::Array(tool_calls);
                    }
                    out.push(entry);
                } else {
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": msg.content.as_text(),
                    }));
                }
            }
            ChatRole::Tool => {
                // Tool results reference the tool_call_id
                if let MessageContent::Blocks(blocks) = &msg.content {
                    for block in blocks {
                        if let ContentBlock::ToolResult {
                            tool_call_id,
                            content,
                            ..
                        } = block
                        {
                            out.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": content,
                            }));
                        }
                    }
                }
            }
            ChatRole::System => {
                out.push(serde_json::json!({
                    "role": "system",
                    "content": msg.content.as_text(),
                }));
            }
        }
    }
    out
}

/// Convert our tool definitions to the OpenAI function-calling format.
fn build_openai_tools(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            })
        })
        .collect()
}

/// Stream a chat completion from an OpenAI-compatible endpoint.
pub async fn stream_chat_compat(
    config: &OpenAiCompatConfig,
    api_key: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));

    let messages = build_openai_messages(
        &request.messages,
        request.system_prompt.as_deref(),
        &request.attachments,
    );
    let tools = build_openai_tools(&request.tools);

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "max_tokens": request.max_tokens,
    });

    if matches!(config.provider_id.as_str(), "openai" | "openrouter") {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }

    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools);
    }
    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }

    let mut headers = config.headers.clone();
    if !api_key.is_empty() {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", api_key))
                .map_err(|e| format!("Invalid API key format: {}", e))?,
        );
    }
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let response = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read response body".to_string());
        let _ = tx
            .send(StreamChunk::Error {
                message: format!(
                    "{} API error ({}): {}",
                    config.provider_id, status, body_text
                ),
            })
            .await;
        return Err(format!("API error ({}): {}", status, body_text));
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

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if line == "data: [DONE]" {
                let _ = tx
                    .send(StreamChunk::Done {
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                    })
                    .await;
                return Ok(());
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    // Extract usage if present
                    if let Some(usage) = parsed.get("usage") {
                        input_tokens = usage
                            .get("prompt_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(input_tokens);
                        output_tokens = usage
                            .get("completion_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(output_tokens);
                    }

                    if let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) {
                        for choice in choices {
                            let delta = match choice.get("delta") {
                                Some(d) => d,
                                None => continue,
                            };

                            // Text content
                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                if !content.is_empty() {
                                    let _ = tx
                                        .send(StreamChunk::TextDelta {
                                            text: content.to_string(),
                                        })
                                        .await;
                                }
                            }

                            // Tool calls
                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|tc| tc.as_array())
                            {
                                for tc in tool_calls {
                                    if let Some(function) = tc.get("function") {
                                        // New tool call start
                                        if let Some(name) =
                                            function.get("name").and_then(|n| n.as_str())
                                        {
                                            // Finish previous tool call if any
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
                                            }

                                            current_tool_id = tc
                                                .get("id")
                                                .and_then(|id| id.as_str())
                                                .unwrap_or("")
                                                .to_string();
                                            current_tool_name = name.to_string();
                                            current_tool_args = String::new();

                                            let _ = tx
                                                .send(StreamChunk::ToolUseStart {
                                                    id: current_tool_id.clone(),
                                                    name: current_tool_name.clone(),
                                                })
                                                .await;
                                        }

                                        // Argument delta
                                        if let Some(args_delta) =
                                            function.get("arguments").and_then(|a| a.as_str())
                                        {
                                            current_tool_args.push_str(args_delta);
                                            let _ = tx
                                                .send(StreamChunk::ToolUseInputDelta {
                                                    delta: args_delta.to_string(),
                                                })
                                                .await;
                                        }
                                    }
                                }
                            }

                            // Check finish_reason for tool_calls
                            if let Some(finish_reason) =
                                choice.get("finish_reason").and_then(|f| f.as_str())
                            {
                                if (finish_reason == "tool_calls"
                                    || finish_reason == "stop"
                                    || finish_reason == "function_call")
                                    && !current_tool_id.is_empty()
                                {
                                    let args = serde_json::from_str(&current_tool_args).unwrap_or(
                                        serde_json::Value::Object(serde_json::Map::new()),
                                    );
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
                        }
                    }
                }
            }
        }
    }

    // If we exited the stream without [DONE], still finalize
    if !current_tool_id.is_empty() {
        let args = serde_json::from_str(&current_tool_args)
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
        let _ = tx
            .send(StreamChunk::ToolUseEnd {
                id: current_tool_id,
                name: current_tool_name,
                arguments: args,
            })
            .await;
    }
    let _ = tx
        .send(StreamChunk::Done {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        })
        .await;

    Ok(())
}
