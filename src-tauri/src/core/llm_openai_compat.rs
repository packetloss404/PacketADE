//! Shared OpenAI-compatible chat completions implementation.
//!
//! Used by OpenAI, MiniMax, OpenRouter, and Ollama providers.

use crate::core::llm_provider::delimit_final_sse_line;
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

/// G16: per-`index` accumulator for a streamed tool call. OpenAI-compatible
/// streams send parallel tool calls distinguished only by a `tool_calls[].index`,
/// and their argument deltas can interleave — so we accumulate each call's id /
/// name / args independently instead of a single "current tool" scalar (which
/// collapsed or cross-contaminated parallel calls).
#[derive(Default)]
struct ToolCallAcc {
    id: String,
    name: String,
    args: String,
    started: bool,
}

/// G16: fold one streamed `tool_calls[]` delta into the per-index accumulator,
/// returning the `ToolUseStart` / `ToolUseInputDelta` chunks to emit for it.
/// Pure (no I/O) so the parallel/interleaved behavior is unit-testable.
fn accumulate_tool_call_delta(
    tc: &serde_json::Value,
    calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>,
) -> Vec<StreamChunk> {
    let mut out = Vec::new();
    let index = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
    let new_id = tc
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let acc = calls.entry(index).or_default();

    // Non-standard providers that OMIT `index` reuse slot 0 for sequential
    // calls. A new, different `id` at an already-started slot therefore means the
    // previous call finished — roll it before starting the new one. (Compliant
    // providers send `id` only on a call's first delta, so this never fires for
    // real parallel calls, which land on distinct indexes.)
    if let Some(id) = new_id {
        if acc.started && !acc.id.is_empty() && acc.id != id {
            if let Some(end) = finish_tool_acc(std::mem::take(acc)) {
                out.push(end);
            }
        }
        acc.id = id.to_string();
    }
    let function = match tc.get("function") {
        Some(f) => f,
        None => return out,
    };
    if let Some(name) = function.get("name").and_then(|n| n.as_str()) {
        if !name.is_empty() {
            acc.name = name.to_string();
        }
    }
    // Emit ToolUseStart once, when the call is first identified.
    if !acc.started && (!acc.id.is_empty() || !acc.name.is_empty()) {
        acc.started = true;
        out.push(StreamChunk::ToolUseStart {
            id: acc.id.clone(),
            name: acc.name.clone(),
        });
    }
    if let Some(args_delta) = function.get("arguments").and_then(|a| a.as_str()) {
        acc.args.push_str(args_delta);
        out.push(StreamChunk::ToolUseInputDelta {
            delta: args_delta.to_string(),
        });
    }
    out
}

/// Build the terminal `ToolUseEnd` for one accumulated call, parsing its args
/// (warning + coercing to `{}` on malformed JSON). None for an empty slot.
fn finish_tool_acc(acc: ToolCallAcc) -> Option<StreamChunk> {
    if acc.id.is_empty() && acc.name.is_empty() && acc.args.is_empty() {
        return None;
    }
    let name_for_log = acc.name.clone();
    let args = serde_json::from_str(&acc.args).unwrap_or_else(|e| {
        tracing::warn!(error = %e, tool = %name_for_log, "malformed tool-arg JSON from stream; coercing to empty object");
        serde_json::Value::Object(serde_json::Map::new())
    });
    Some(StreamChunk::ToolUseEnd {
        id: acc.id,
        name: acc.name,
        arguments: args,
    })
}

/// Drain the accumulator into a `ToolUseEnd` per call, in `index` order. Pure.
fn drain_tool_calls(calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>) -> Vec<StreamChunk> {
    std::mem::take(calls)
        .into_iter()
        .filter_map(|(_index, acc)| finish_tool_acc(acc))
        .collect()
}

/// Emit `ToolUseEnd` for every accumulated tool call, then clear the
/// accumulator. Called at each stream terminator (finish_reason, `[DONE]`, and
/// the post-loop finalize).
async fn flush_tool_calls(
    tx: &mpsc::Sender<StreamChunk>,
    calls: &mut std::collections::BTreeMap<i64, ToolCallAcc>,
) {
    for chunk in drain_tool_calls(calls) {
        let _ = tx.send(chunk).await;
    }
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

    // MiniMax is OpenAI-compatible and honors `stream_options.include_usage`, so
    // include it here to get token/cost counts (was OpenAI/OpenRouter only). Ollama
    // is deliberately left out: older builds reject unknown params, and a hard
    // stream failure isn't worth cosmetic usage counts — revisit once verified.
    if matches!(
        config.provider_id.as_str(),
        "openai" | "openrouter" | "minimax"
    ) {
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
        return Err(format!(
            "{} API error ({}): {}",
            config.provider_id, status, body_text
        ));
    }

    let mut stream = response.bytes_stream();
    // F46: buffer raw bytes rather than lossy-decoding each chunk. A multibyte
    // UTF-8 char split across two chunks would otherwise be mangled into U+FFFD
    // by a per-chunk from_utf8_lossy. SSE lines are '\n'-terminated (an ASCII
    // byte that cannot occur mid-codepoint), so a complete line is always a
    // complete UTF-8 sequence; we only decode once a full line is buffered.
    let mut buffer: Vec<u8> = Vec::new();
    // G16: tool calls keyed by their streamed `index` (BTreeMap → emitted in
    // index order), so parallel calls with interleaving arg deltas don't collapse.
    let mut tool_calls_acc: std::collections::BTreeMap<i64, ToolCallAcc> =
        std::collections::BTreeMap::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;

    let mut stream_ended = false;
    loop {
        // RA1: if the consumer dropped the receiver, stop parsing the rest of the
        // upstream HTTP stream instead of draining it into a dead channel.
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
                    delimit_final_sse_line(&mut buffer);
                }
            }
        }

        // Process complete SSE lines
        while let Some(line_end) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=line_end).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if line == "data: [DONE]" {
                flush_tool_calls(&tx, &mut tool_calls_acc).await;
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

                            // Tool calls. G16: several may stream in parallel,
                            // distinguished only by `index`; accumulate each
                            // independently rather than flushing on every new
                            // name (which collapsed/cross-contaminated them).
                            if let Some(tool_calls) =
                                delta.get("tool_calls").and_then(|tc| tc.as_array())
                            {
                                for tc in tool_calls {
                                    for chunk in accumulate_tool_call_delta(tc, &mut tool_calls_acc)
                                    {
                                        let _ = tx.send(chunk).await;
                                    }
                                }
                            }

                            // finish_reason terminates the turn — flush every
                            // accumulated tool call (in index order). "stop" is a
                            // defensive extra terminator; flush_tool_calls is a
                            // no-op when nothing was accumulated.
                            if let Some(finish_reason) =
                                choice.get("finish_reason").and_then(|f| f.as_str())
                            {
                                if finish_reason == "tool_calls"
                                    || finish_reason == "stop"
                                    || finish_reason == "function_call"
                                {
                                    flush_tool_calls(&tx, &mut tool_calls_acc).await;
                                }
                            }
                        }
                    }
                }
            }
        }

        if stream_ended {
            break;
        }
    }

    // If we exited the stream without [DONE]/finish_reason, still flush any
    // accumulated tool calls before signalling Done.
    flush_tool_calls(&tx, &mut tool_calls_acc).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn parallel_tool_calls_do_not_cross_contaminate() {
        // G16: interleaved deltas — call 0 starts, call 1 starts, THEN call 0's
        // args, then call 1's args. The old single-scalar parser appended call
        // 0's args onto call 1 (cross-contamination); per-index accumulation
        // keeps them separate.
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        let deltas = [
            json!({"index":0,"id":"call_a","function":{"name":"foo","arguments":""}}),
            json!({"index":1,"id":"call_b","function":{"name":"bar","arguments":""}}),
            json!({"index":0,"function":{"arguments":"{\"x\":1}"}}),
            json!({"index":1,"function":{"arguments":"{\"y\":2}"}}),
        ];
        for d in &deltas {
            let _ = accumulate_tool_call_delta(d, &mut acc);
        }
        let ends = drain_tool_calls(&mut acc);
        assert_eq!(ends.len(), 2, "one ToolUseEnd per parallel call");
        match (&ends[0], &ends[1]) {
            (
                StreamChunk::ToolUseEnd {
                    id: id0,
                    name: n0,
                    arguments: a0,
                },
                StreamChunk::ToolUseEnd {
                    id: id1,
                    name: n1,
                    arguments: a1,
                },
            ) => {
                // Emitted in index order, each with its OWN id/name/args.
                assert_eq!(id0, "call_a");
                assert_eq!(n0, "foo");
                assert_eq!(a0["x"], 1);
                assert_eq!(id1, "call_b");
                assert_eq!(n1, "bar");
                assert_eq!(a1["y"], 2);
            }
            _ => panic!("expected two ToolUseEnd chunks"),
        }
        assert!(acc.is_empty(), "drain clears the accumulator");
    }

    #[test]
    fn accumulate_emits_tool_use_start_once_per_index() {
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        let first = accumulate_tool_call_delta(
            &json!({"index":0,"id":"a","function":{"name":"foo","arguments":"{"}}),
            &mut acc,
        );
        assert!(matches!(first[0], StreamChunk::ToolUseStart { .. }));
        // A second delta for the same index must NOT re-emit ToolUseStart.
        let more =
            accumulate_tool_call_delta(&json!({"index":0,"function":{"arguments":"}"}}), &mut acc);
        assert!(more
            .iter()
            .all(|c| !matches!(c, StreamChunk::ToolUseStart { .. })));
        let ends = drain_tool_calls(&mut acc);
        assert_eq!(ends.len(), 1);
    }

    #[test]
    fn index_omitting_provider_sequential_calls_do_not_collapse() {
        // A non-standard server that omits `index` and streams two calls back to
        // back (each with its own id). The new-id-at-started-slot guard rolls the
        // first call before starting the second, so they don't merge.
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        let mut emitted: Vec<StreamChunk> = Vec::new();
        for d in [
            json!({"id":"c1","function":{"name":"foo","arguments":"{\"x\":1}"}}),
            json!({"id":"c2","function":{"name":"bar","arguments":"{\"y\":2}"}}),
        ] {
            emitted.extend(accumulate_tool_call_delta(&d, &mut acc));
        }
        emitted.extend(drain_tool_calls(&mut acc));
        let ends: Vec<_> = emitted
            .iter()
            .filter(|c| matches!(c, StreamChunk::ToolUseEnd { .. }))
            .collect();
        assert_eq!(ends.len(), 2, "two distinct calls, not one merged");
        if let StreamChunk::ToolUseEnd { id, arguments, .. } = ends[0] {
            assert_eq!(id, "c1");
            assert_eq!(arguments["x"], 1);
        }
        if let StreamChunk::ToolUseEnd { id, arguments, .. } = ends[1] {
            assert_eq!(id, "c2");
            assert_eq!(arguments["y"], 2);
        }
    }

    #[test]
    fn single_tool_call_still_works() {
        let mut acc: BTreeMap<i64, ToolCallAcc> = BTreeMap::new();
        for d in [
            json!({"index":0,"id":"c1","function":{"name":"do","arguments":"{\"a\":"}}),
            json!({"index":0,"function":{"arguments":"true}"}}),
        ] {
            let _ = accumulate_tool_call_delta(&d, &mut acc);
        }
        let ends = drain_tool_calls(&mut acc);
        assert_eq!(ends.len(), 1);
        if let StreamChunk::ToolUseEnd {
            id,
            name,
            arguments,
        } = &ends[0]
        {
            assert_eq!(id, "c1");
            assert_eq!(name, "do");
            assert_eq!(arguments["a"], true);
        } else {
            panic!("expected ToolUseEnd");
        }
    }
}
