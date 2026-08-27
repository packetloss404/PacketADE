//! Ollama provider (local, no API key) — native `/api/chat` transport.
//!
//! ## Why not the OpenAI-compatible endpoint?
//!
//! This provider used to be a 40-line passthrough to
//! [`stream_chat_compat`] against `{base}/v1/chat/completions`. That endpoint
//! **cannot** carry the two options that decide whether local inference works
//! at all:
//!
//! * `num_ctx` — Ollama's OpenAI-compat layer has no way to set the context
//!   window, so every request ran at the daemon default (4096 tokens on
//!   current builds, 2048 historically) and Ollama **silently truncated the
//!   front of the conversation**. No error, no field, no signal. It presents
//!   as "the local model forgot the system prompt" / "the local model is
//!   stupid", and it is our request that is wrong, not the model.
//!   Ollama's own docs are explicit: *"The OpenAI API does not have a way of
//!   setting the context size for a model"*, and direct users to a Modelfile
//!   (<https://docs.ollama.com/api/openai-compatibility>).
//! * `keep_alive` — without it the daemon unloads the model after its default
//!   5 minutes, so every turn of a slow agent loop pays a full cold reload.
//!
//! Both are `options` / top-level fields of the **native** `/api/chat` route
//! (<https://docs.ollama.com/api/chat>), which is what this module now speaks.
//! The OpenAI-compat path survives only as a fallback for endpoints that
//! answer `/v1/*` but not `/api/chat` (a proxy or an LM-Studio-style server
//! pointed at this row); that fallback cannot set `num_ctx` and says so.
//!
//! ## Wire-format differences the native route imposes
//!
//! * Streaming is newline-delimited JSON, not SSE (`data: ` framed).
//! * Tool calls arrive **complete** (`function.arguments` is a JSON *object*,
//!   not a string fragment stream) and carry **no id** — we synthesise one.
//! * Tool results are replayed as `{"role":"tool","tool_name":...}`; there is
//!   no `tool_call_id`, so we map our ids back to names from the assistant
//!   turns already in history.
//! * Images ride on the user message as bare base64 in `images: []`.
//! * Usage is `prompt_eval_count` / `eval_count`; there is no cache bucket.

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use futures::StreamExt;
use reqwest::header::HeaderMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

/// Upper bound we are willing to ask a local daemon to allocate, in tokens,
/// before the user raises it in Settings → Tools → Provider Endpoints.
///
/// KV-cache cost is roughly `2 * layers * kv_heads * head_dim * 2 bytes` per
/// token; for a typical 7–8B GQA model that is ~128 KiB/token, so 16384 tokens
/// is ~2 GiB of VRAM on top of the weights — the most that reliably co-exists
/// with a q4 7–8B model on an 8 GB card. It is also 4x Ollama's own default
/// and comfortably larger than every auxiliary task class this product routes
/// locally. Users with more VRAM raise it; the model's own trained window is
/// always the hard ceiling (see [`derive_num_ctx`]).
pub const DEFAULT_NUM_CTX_CAP: u32 = 16_384;

/// Used when `/api/show` does not report a context length (old daemon, custom
/// model, daemon unreachable during the probe). Deliberately conservative but
/// still 2x the daemon default, so an unknown model is not silently crippled.
pub const FALLBACK_MODEL_CONTEXT_TOKENS: u32 = 8_192;

/// Floor for the *cap* setting. A cap below this is a mis-entry, not a choice;
/// note this floors the cap, never the model's own smaller window.
pub const MIN_NUM_CTX_CAP: u32 = 2_048;

/// How long the daemon keeps the model resident after a turn. Ollama's default
/// is `5m`, which expires inside a normal agent loop (tool round-trips, a user
/// reading a diff), and every expiry costs a multi-second reload.
pub const DEFAULT_KEEP_ALIVE: &str = "30m";

/// Probe timeout for `/api/show`. Local, so this is generous; a slow answer
/// means the daemon is busy loading and the chat request will say so properly.
const SHOW_TIMEOUT: Duration = Duration::from_millis(3_000);

fn resolve_base_url() -> String {
    crate::core::storage::resolve_ollama_root_base_url()
}

/// Effective `num_ctx` ceiling: saved setting → env override → built-in.
pub fn resolve_num_ctx_cap() -> u32 {
    crate::core::storage::load_saved_ollama_num_ctx_cap()
        .or_else(|| {
            std::env::var("PACKETBENCH_OLLAMA_NUM_CTX_CAP")
                .ok()
                .and_then(|raw| raw.trim().parse::<u32>().ok())
        })
        .filter(|cap| *cap > 0)
        .unwrap_or(DEFAULT_NUM_CTX_CAP)
        .max(MIN_NUM_CTX_CAP)
}

/// Effective `keep_alive`: saved setting → env override → built-in.
pub fn resolve_keep_alive() -> String {
    crate::core::storage::load_saved_ollama_keep_alive()
        .or_else(|| {
            std::env::var("PACKETBENCH_OLLAMA_KEEP_ALIVE")
                .ok()
                .and_then(|raw| normalize_keep_alive(&raw).ok())
        })
        .unwrap_or_else(|| DEFAULT_KEEP_ALIVE.to_string())
}

/// Validate a `keep_alive` value. Ollama accepts a Go duration string
/// (`30m`, `24h`, `500ms`), a bare number of seconds, or a negative value
/// meaning "never unload". Anything else would be rejected by the daemon at
/// request time, which is a confusing place to find out.
pub fn normalize_keep_alive(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Keep-alive cannot be empty.".to_string());
    }
    let (digits, unit) = match trimmed.find(|c: char| !c.is_ascii_digit() && c != '-' && c != '.') {
        Some(idx) => trimmed.split_at(idx),
        None => (trimmed, ""),
    };
    if digits.is_empty() || digits == "-" || digits.parse::<f64>().is_err() {
        return Err("Keep-alive must be a duration like 30m, 24h, 0 or -1.".to_string());
    }
    if !matches!(unit, "" | "ms" | "s" | "m" | "h") {
        return Err("Keep-alive unit must be ms, s, m or h (for example 30m).".to_string());
    }
    Ok(trimmed.to_string())
}

/// What `/api/show` tells us about one model.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct OllamaModelProfile {
    /// Trained context window, from the `*.context_length` key in `model_info`.
    pub context_length: Option<u32>,
    /// Reported capabilities (`completion`, `tools`, `vision`, `thinking`, …).
    /// Empty means "the daemon did not tell us", which is not the same as
    /// "supports nothing" — old daemons omit the field entirely.
    pub capabilities: Vec<String>,
}

impl OllamaModelProfile {
    /// `None` when the daemon reported no capability list at all.
    pub(crate) fn supports_tools(&self) -> Option<bool> {
        if self.capabilities.is_empty() {
            return None;
        }
        Some(self.capabilities.iter().any(|c| c == "tools"))
    }
}

/// Parse an `/api/show` body. Pure, so the key-shape handling is testable
/// without a daemon: the context-length key is architecture-prefixed
/// (`llama.context_length`, `qwen3.context_length`, …), so we scan for the
/// suffix rather than guessing the architecture.
pub(crate) fn parse_show_response(body: &serde_json::Value) -> OllamaModelProfile {
    let context_length = body
        .get("model_info")
        .and_then(|info| info.as_object())
        .and_then(|info| {
            info.iter()
                .filter(|(key, _)| {
                    key.as_str() == "context_length" || key.ends_with(".context_length")
                })
                .filter_map(|(_, value)| value.as_u64())
                .max()
        })
        .and_then(|len| u32::try_from(len).ok())
        .filter(|len| *len > 0);

    let capabilities = body
        .get("capabilities")
        .and_then(|c| c.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    OllamaModelProfile {
        context_length,
        capabilities,
    }
}

/// Process-lifetime memo of `/api/show` answers, keyed `"{base}|{model}"`.
/// A model's context window and capabilities do not change under us, and the
/// probe would otherwise run on every turn of an agent loop.
fn profile_cache() -> &'static Mutex<HashMap<String, OllamaModelProfile>> {
    static CACHE: OnceLock<Mutex<HashMap<String, OllamaModelProfile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) async fn fetch_model_profile(base_url: &str, model: &str) -> Option<OllamaModelProfile> {
    let key = format!("{}|{}", base_url, model);
    if let Some(cached) = profile_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
    {
        return Some(cached);
    }

    let client = reqwest::Client::builder()
        .timeout(SHOW_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .post(format!("{}/api/show", base_url))
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        tracing::warn!(
            model = %model,
            status = %response.status(),
            "Ollama /api/show failed; falling back to a conservative num_ctx"
        );
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    let profile = parse_show_response(&body);
    if let Ok(mut cache) = profile_cache().lock() {
        cache.insert(key, profile.clone());
    }
    Some(profile)
}

/// Pick the `num_ctx` to send.
///
/// Deliberately a function of the **model and the cap only** — never of the
/// current prompt size. Ollama reloads the model whenever `num_ctx` changes,
/// so a per-request value would defeat `keep_alive` and make every turn pay a
/// reload. The model's own trained window is a hard ceiling: exceeding it
/// silently degrades quality via rope scaling.
pub(crate) fn derive_num_ctx(model_context: Option<u32>, cap: u32) -> u32 {
    let cap = cap.max(MIN_NUM_CTX_CAP);
    let model_ctx = model_context
        .filter(|len| *len > 0)
        .unwrap_or(FALLBACK_MODEL_CONTEXT_TOKENS);
    model_ctx.min(cap)
}

/// Rough token estimate for overflow detection, from raw content length.
/// Structural JSON is excluded and 4 chars/token is a mild over-estimate of
/// real tokenisation for prose, so this fires only on genuine overflow — it is
/// the *secondary* signal; `prompt_eval_count` is the authoritative one.
///
/// `images` is skipped: it holds base64 blobs whose character count has nothing
/// to do with how many tokens the vision encoder produces, and counting them
/// would fire the overflow warning on every screenshot.
pub(crate) fn estimate_prompt_tokens(
    messages: &[serde_json::Value],
    tools: &[serde_json::Value],
) -> u32 {
    fn text_len(value: &serde_json::Value) -> usize {
        match value {
            serde_json::Value::String(s) => s.chars().count(),
            serde_json::Value::Array(items) => items.iter().map(text_len).sum(),
            serde_json::Value::Object(map) => map
                .iter()
                .filter(|(key, _)| key.as_str() != "images")
                .map(|(_, value)| text_len(value))
                .sum(),
            _ => 0,
        }
    }
    let chars: usize =
        messages.iter().map(text_len).sum::<usize>() + tools.iter().map(text_len).sum::<usize>();
    u32::try_from(chars / 4).unwrap_or(u32::MAX)
}

/// Build the user-visible warning for a turn that Ollama truncated, or `None`
/// when nothing was dropped.
///
/// Ollama has **no** truncation field: it drops the oldest prompt tokens and
/// answers as if nothing happened. Two signals expose it:
/// * `prompt_eval_count >= num_ctx` — authoritative when the prompt was
///   actually evaluated (a warm KV-cache hit can under-report it, hence the
///   second signal).
/// * our own estimate exceeding `num_ctx`.
///
/// `done_reason == "length"` is the *output* side of the same silence: the
/// answer stopped at `num_predict` rather than finishing.
pub(crate) fn truncation_notice(
    num_ctx: u32,
    num_predict: u32,
    estimated_prompt_tokens: u32,
    prompt_eval_count: Option<u64>,
    done_reason: Option<&str>,
) -> Option<String> {
    let evaluated_overflow = prompt_eval_count.is_some_and(|count| count >= u64::from(num_ctx));
    if evaluated_overflow || estimated_prompt_tokens > num_ctx {
        let observed = prompt_eval_count
            .map(|count| format!("{} tokens evaluated", count))
            .unwrap_or_else(|| format!("~{} tokens estimated", estimated_prompt_tokens));
        return Some(format!(
            "\n\n---\n**Ollama context overflow.** This prompt did not fit the model's \
             context window (num_ctx = {num_ctx}; {observed}). Ollama drops the oldest \
             messages *silently* when this happens, so the reply above was produced \
             without part of the conversation. Raise the context cap in \
             Settings → Tools → Provider Endpoints, or use a model with a larger window.",
        ));
    }
    if done_reason == Some("length") {
        return Some(format!(
            "\n\n---\n**Response truncated** at the output-token limit (num_predict = {num_predict}).",
        ));
    }
    None
}

/// Synthesise a tool-call id. The native API sends none, but the rest of the
/// app (history, permission prompts, the sidecar-shaped events) keys on one.
fn next_tool_call_id(name: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "ollama-{}-{}",
        name,
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// `tool_call_id -> tool name`, harvested from the assistant turns already in
/// history. The native API replays tool results by **name**, so without this
/// map a multi-round tool conversation cannot be reconstructed.
pub(crate) fn tool_names_by_call_id(messages: &[ChatMessage]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for message in messages {
        if let MessageContent::Blocks(blocks) = &message.content {
            for block in blocks {
                if let ContentBlock::ToolUse { id, name, .. } = block {
                    map.insert(id.clone(), name.clone());
                }
            }
        }
    }
    map
}

/// Strip a `data:` URL prefix if present — Ollama wants bare base64.
fn bare_base64(data: &str) -> String {
    match data.split_once(";base64,") {
        Some((_, payload)) => payload.to_string(),
        None => data.to_string(),
    }
}

/// Convert our internal messages into the native `/api/chat` shape.
pub(crate) fn build_ollama_messages(
    messages: &[ChatMessage],
    system_prompt: Option<&str>,
    attachments: &[ImageAttachment],
) -> Vec<serde_json::Value> {
    let tool_names = tool_names_by_call_id(messages);
    let mut out: Vec<serde_json::Value> = Vec::new();

    if let Some(system) = system_prompt {
        out.push(serde_json::json!({ "role": "system", "content": system }));
    }

    let last_user_idx = messages
        .iter()
        .rposition(|m| matches!(m.role, ChatRole::User));

    for (idx, message) in messages.iter().enumerate() {
        match message.role {
            ChatRole::System => {
                out.push(serde_json::json!({
                    "role": "system",
                    "content": message.content.as_text(),
                }));
            }
            ChatRole::User => {
                let mut images: Vec<String> = Vec::new();
                if let MessageContent::Blocks(blocks) = &message.content {
                    for block in blocks {
                        if let ContentBlock::Image { data_base64, .. } = block {
                            images.push(bare_base64(data_base64));
                        }
                    }
                }
                if Some(idx) == last_user_idx {
                    for attachment in attachments {
                        images.push(bare_base64(&attachment.data_base64));
                    }
                }
                let mut entry = serde_json::json!({
                    "role": "user",
                    "content": message.content.as_text(),
                });
                if !images.is_empty() {
                    entry["images"] = serde_json::json!(images);
                }
                out.push(entry);
            }
            ChatRole::Assistant => {
                if let MessageContent::Blocks(blocks) = &message.content {
                    let mut text_parts: Vec<String> = Vec::new();
                    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } => text_parts.push(text.clone()),
                            ContentBlock::ToolUse {
                                name, arguments, ..
                            } => tool_calls.push(serde_json::json!({
                                "function": { "name": name, "arguments": arguments },
                            })),
                            // ProviderReasoning is MiniMax's opaque payload; it
                            // is inert here (Ollama carries thinking as a plain
                            // `thinking` string and does not require replay).
                            _ => {}
                        }
                    }
                    let mut entry = serde_json::json!({
                        "role": "assistant",
                        "content": text_parts.join("\n"),
                    });
                    if !tool_calls.is_empty() {
                        entry["tool_calls"] = serde_json::Value::Array(tool_calls);
                    }
                    out.push(entry);
                } else {
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": message.content.as_text(),
                    }));
                }
            }
            ChatRole::Tool => {
                if let MessageContent::Blocks(blocks) = &message.content {
                    for block in blocks {
                        if let ContentBlock::ToolResult {
                            tool_call_id,
                            content,
                            ..
                        } = block
                        {
                            let mut entry = serde_json::json!({
                                "role": "tool",
                                "content": content,
                            });
                            if let Some(name) = tool_names.get(tool_call_id) {
                                entry["tool_name"] = serde_json::json!(name);
                            }
                            out.push(entry);
                        }
                    }
                }
            }
        }
    }

    out
}

fn build_ollama_tools(tools: &[ToolDefinition]) -> Vec<serde_json::Value> {
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

pub struct OllamaProvider;

impl OllamaProvider {
    fn base_url(&self) -> String {
        resolve_base_url()
    }
}

#[async_trait::async_trait]
impl LlmProvider for OllamaProvider {
    async fn stream_chat(
        &self,
        _api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        stream_native_chat(&self.base_url(), request, tx).await
    }

    fn provider_id(&self) -> &str {
        "ollama"
    }
}

/// Fallback for endpoints that serve `/v1/*` but not `/api/chat`. Cannot set
/// `num_ctx`, so it is announced as the degraded path rather than used quietly.
async fn stream_compat_fallback(
    base_url: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    tracing::warn!(
        base_url = %base_url,
        "Endpoint has no native /api/chat; falling back to the OpenAI-compatible route. \
         num_ctx and keep_alive CANNOT be set on that route, so long prompts may be \
         truncated by the server without notice."
    );
    let config = OpenAiCompatConfig {
        base_url: format!("{}/v1", base_url.trim_end_matches('/')),
        headers: HeaderMap::new(),
        provider_id: "ollama".to_string(),
    };
    stream_chat_compat(&config, "", request, tx).await
}

async fn stream_native_chat(
    base_url: &str,
    request: LlmRequest,
    tx: mpsc::Sender<StreamChunk>,
) -> Result<(), String> {
    let base_url = base_url.trim_end_matches('/').to_string();
    let profile = fetch_model_profile(&base_url, &request.model).await;

    // A model without a tools template answers a tool request by ignoring the
    // tools (or with an opaque daemon error). Say so plainly instead.
    if !request.tools.is_empty() {
        if let Some(false) = profile
            .as_ref()
            .and_then(OllamaModelProfile::supports_tools)
        {
            return Err(format!(
                "The Ollama model '{}' does not support tool calling (no tools template). \
                 Pick a tool-capable model — `ollama show {} --capabilities` lists what it can do.",
                request.model, request.model
            ));
        }
    }

    let cap = resolve_num_ctx_cap();
    let num_ctx = derive_num_ctx(profile.as_ref().and_then(|p| p.context_length), cap);
    let num_predict = request.max_tokens.min(num_ctx);
    let keep_alive = resolve_keep_alive();

    let messages = build_ollama_messages(
        &request.messages,
        request.system_prompt.as_deref(),
        &request.attachments,
    );
    let tools = build_ollama_tools(&request.tools);
    let estimated_prompt_tokens = estimate_prompt_tokens(&messages, &tools);

    let mut options = serde_json::json!({
        "num_ctx": num_ctx,
        "num_predict": num_predict,
    });
    if let Some(temperature) = request.temperature {
        options["temperature"] = serde_json::json!(temperature);
    }

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "options": options,
        "keep_alive": keep_alive,
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools.clone());
    }

    tracing::debug!(
        model = %request.model,
        num_ctx,
        num_predict,
        keep_alive = %keep_alive,
        model_context = ?profile.as_ref().and_then(|p| p.context_length),
        estimated_prompt_tokens,
        "Ollama native /api/chat request"
    );
    if estimated_prompt_tokens > num_ctx {
        tracing::warn!(
            model = %request.model,
            num_ctx,
            estimated_prompt_tokens,
            "Ollama prompt is larger than the negotiated context window; the daemon will \
             silently drop the oldest messages"
        );
    }

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/api/chat", base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            // Connection-shaped failures get the same stable message as
            // `commands::ollama::list_ollama_models`, which Q3's fail-closed
            // retry in `core::aux_llm` keys on.
            if e.is_connect() || e.is_timeout() {
                format!("Ollama not reachable at {}", base_url)
            } else {
                format!("Ollama request failed: {}", e)
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        // Only a missing route justifies the degraded OpenAI-compat path; a
        // real error (model not found, out of memory) must surface as itself.
        if matches!(
            status,
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
        ) {
            return stream_compat_fallback(&base_url, request, tx).await;
        }
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read response body".to_string());
        return Err(format!("Ollama API error ({}): {}", status, body_text));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut thinking_open = false;
    let mut prompt_eval_count: Option<u64> = None;
    let mut eval_count: u64 = 0;
    let mut done_reason: Option<String> = None;
    let mut stream_ended = false;
    let mut done_seen = false;

    loop {
        if tx.is_closed() {
            return Ok(());
        }
        if !stream_ended {
            match stream.next().await {
                Some(chunk) => {
                    let chunk = chunk.map_err(|e| format!("Ollama stream error: {}", e))?;
                    buffer.extend_from_slice(&chunk);
                }
                None => {
                    stream_ended = true;
                    crate::core::llm_provider::delimit_final_sse_line(&mut buffer);
                }
            }
        }

        while let Some(line_end) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=line_end).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim().to_string();
            if line.is_empty() {
                continue;
            }
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(e) => {
                    tracing::warn!(error = %e, "Unparsable line from Ollama stream; skipping");
                    continue;
                }
            };

            // A mid-stream `error` is the daemon giving up (model unloaded,
            // OOM). Surface it rather than ending the turn as if it succeeded.
            if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
                return Err(format!("Ollama API error: {}", error));
            }

            if let Some(message) = parsed.get("message") {
                if let Some(thinking) = message.get("thinking").and_then(|t| t.as_str()) {
                    if !thinking.is_empty() {
                        thinking_open = true;
                        let _ = tx
                            .send(StreamChunk::ThinkingDelta {
                                text: thinking.to_string(),
                            })
                            .await;
                    }
                }
                if let Some(content) = message.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        let _ = tx
                            .send(StreamChunk::TextDelta {
                                text: content.to_string(),
                            })
                            .await;
                    }
                }
                if let Some(tool_calls) = message.get("tool_calls").and_then(|tc| tc.as_array()) {
                    for chunk in native_tool_call_chunks(tool_calls) {
                        let _ = tx.send(chunk).await;
                    }
                }
            }

            if parsed.get("done").and_then(|d| d.as_bool()) == Some(true) {
                prompt_eval_count = parsed
                    .get("prompt_eval_count")
                    .and_then(|v| v.as_u64())
                    .or(prompt_eval_count);
                eval_count = parsed
                    .get("eval_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(eval_count);
                done_reason = parsed
                    .get("done_reason")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                done_seen = true;
            }
        }

        // `stream_ended` alone must terminate the loop: a trailing fragment
        // with no newline would otherwise spin forever with nothing left to
        // read. `delimit_final_sse_line` has already framed it by this point.
        if done_seen || stream_ended {
            break;
        }
    }

    if thinking_open {
        let _ = tx.send(StreamChunk::ThinkingStop).await;
    }

    if let Some(notice) = truncation_notice(
        num_ctx,
        num_predict,
        estimated_prompt_tokens,
        prompt_eval_count,
        done_reason.as_deref(),
    ) {
        tracing::warn!(
            model = %request.model,
            num_ctx,
            prompt_eval_count = ?prompt_eval_count,
            done_reason = ?done_reason,
            "Ollama truncated this turn"
        );
        let _ = tx.send(StreamChunk::TextDelta { text: notice }).await;
    }
    let _ = tx
        .send(StreamChunk::Done {
            input_tokens: prompt_eval_count.unwrap_or(0),
            output_tokens: eval_count,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
        })
        .await;

    Ok(())
}

/// Turn one streamed `tool_calls` array into our chunk trio. The native API
/// delivers each call whole, so start/args/end are emitted back to back —
/// consumers that accumulate `ToolUseInputDelta` still see consistent state.
fn native_tool_call_chunks(tool_calls: &[serde_json::Value]) -> Vec<StreamChunk> {
    let mut out = Vec::new();
    for call in tool_calls {
        let Some(function) = call.get("function") else {
            continue;
        };
        let name = function
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let arguments = function
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        let id = call
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| next_tool_call_id(&name));
        out.push(StreamChunk::ToolUseStart {
            id: id.clone(),
            name: name.clone(),
        });
        out.push(StreamChunk::ToolUseInputDelta {
            delta: arguments.to_string(),
        });
        out.push(StreamChunk::ToolUseEnd {
            id,
            name,
            arguments,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Mutex as StdMutex, OnceLock as StdOnceLock};

    fn env_lock() -> &'static StdMutex<()> {
        static LOCK: StdOnceLock<StdMutex<()>> = StdOnceLock::new();
        LOCK.get_or_init(|| StdMutex::new(()))
    }

    #[test]
    fn default_root_base_url_maps_to_ollama_v1() {
        let _guard = env_lock().lock().unwrap();
        assert_eq!(
            format!("{}/v1", crate::core::storage::DEFAULT_OLLAMA_ROOT_BASE_URL),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn normalize_base_url_accepts_ollama_v1() {
        let _guard = env_lock().lock().unwrap();
        let root =
            crate::core::storage::normalize_ollama_root_base_url("http://new.example.com:11434/v1")
                .unwrap();
        assert_eq!(format!("{}/v1", root), "http://new.example.com:11434/v1");
    }

    #[test]
    fn normalize_base_url_rejects_missing_scheme() {
        let _guard = env_lock().lock().unwrap();
        assert!(crate::core::storage::normalize_ollama_root_base_url("localhost:11434").is_err());
    }

    /// LM1: the whole point. The request must carry both options, on the
    /// native route — the OpenAI-compatible route cannot express either.
    #[test]
    fn native_request_carries_num_ctx_and_keep_alive() {
        let body = json!({
            "model": "qwen3:8b",
            "options": { "num_ctx": derive_num_ctx(Some(131_072), DEFAULT_NUM_CTX_CAP) },
            "keep_alive": DEFAULT_KEEP_ALIVE,
        });
        assert_eq!(body["options"]["num_ctx"], DEFAULT_NUM_CTX_CAP);
        assert_eq!(body["keep_alive"], "30m");
    }

    #[test]
    fn num_ctx_uses_the_model_window_when_it_is_below_the_cap() {
        // A 4k model must not be asked for 16k: exceeding the trained window
        // degrades quality via rope scaling.
        assert_eq!(derive_num_ctx(Some(4_096), DEFAULT_NUM_CTX_CAP), 4_096);
    }

    #[test]
    fn num_ctx_is_capped_for_huge_windows() {
        // 1M-context local models exist; allocating their KV cache does not.
        assert_eq!(derive_num_ctx(Some(1_000_000), 32_768), 32_768);
    }

    #[test]
    fn num_ctx_falls_back_sensibly_for_unknown_models() {
        assert_eq!(
            derive_num_ctx(None, DEFAULT_NUM_CTX_CAP),
            FALLBACK_MODEL_CONTEXT_TOKENS
        );
        // ...and still respects a cap lower than the fallback.
        assert_eq!(derive_num_ctx(None, 4_096), 4_096);
        // A zero/absurd cap is a mis-entry, not an instruction to cripple.
        assert_eq!(derive_num_ctx(Some(131_072), 0), MIN_NUM_CTX_CAP);
    }

    #[test]
    fn show_response_yields_context_length_and_capabilities() {
        let profile = parse_show_response(&json!({
            "model_info": {
                "general.architecture": "qwen3",
                "qwen3.context_length": 40_960,
                "qwen3.embedding_length": 4096
            },
            "capabilities": ["completion", "tools", "thinking"]
        }));
        assert_eq!(profile.context_length, Some(40_960));
        assert_eq!(profile.supports_tools(), Some(true));
    }

    #[test]
    fn show_response_without_capabilities_is_unknown_not_unsupported() {
        let profile =
            parse_show_response(&json!({ "model_info": { "llama.context_length": 8192 } }));
        assert_eq!(profile.context_length, Some(8_192));
        assert_eq!(profile.supports_tools(), None, "old daemons omit the field");
    }

    #[test]
    fn show_response_reports_missing_tool_capability() {
        let profile = parse_show_response(&json!({ "capabilities": ["completion"] }));
        assert_eq!(profile.supports_tools(), Some(false));
        assert_eq!(profile.context_length, None);
    }

    /// The defect: Ollama has no truncation field, so an overflowing prompt
    /// must be inferred and surfaced instead of dropped on the floor.
    #[test]
    fn evaluated_prompt_filling_the_window_surfaces_a_notice() {
        let notice = truncation_notice(8_192, 4_096, 100, Some(8_192), Some("stop"))
            .expect("prompt_eval_count >= num_ctx means the front was dropped");
        assert!(notice.contains("context overflow"));
        assert!(notice.contains("8192"));
    }

    #[test]
    fn oversized_estimate_surfaces_a_notice_even_on_a_warm_cache() {
        // A warm KV cache under-reports prompt_eval_count, so the estimate is
        // the backstop signal.
        let notice = truncation_notice(8_192, 4_096, 20_000, Some(12), Some("stop"))
            .expect("estimate over num_ctx must still warn");
        assert!(notice.contains("context overflow"));
    }

    #[test]
    fn output_length_stop_is_surfaced_separately() {
        let notice = truncation_notice(8_192, 512, 100, Some(120), Some("length"))
            .expect("done_reason=length is output truncation");
        assert!(notice.contains("Response truncated"));
        assert!(notice.contains("512"));
    }

    #[test]
    fn a_normal_turn_produces_no_notice() {
        assert!(truncation_notice(8_192, 4_096, 100, Some(120), Some("stop")).is_none());
        assert!(truncation_notice(8_192, 4_096, 100, None, None).is_none());
    }

    #[test]
    fn keep_alive_accepts_durations_and_rejects_junk() {
        assert_eq!(normalize_keep_alive(" 30m ").unwrap(), "30m");
        assert_eq!(normalize_keep_alive("-1").unwrap(), "-1");
        assert_eq!(normalize_keep_alive("500ms").unwrap(), "500ms");
        assert_eq!(normalize_keep_alive("120").unwrap(), "120");
        assert!(normalize_keep_alive("forever").is_err());
        assert!(normalize_keep_alive("30 minutes").is_err());
        assert!(normalize_keep_alive("").is_err());
    }

    #[test]
    fn tool_results_replay_by_name_because_the_native_api_has_no_call_id() {
        let messages = vec![
            ChatMessage {
                role: ChatRole::Assistant,
                content: MessageContent::Blocks(vec![ContentBlock::ToolUse {
                    id: "ollama-read_file-0".to_string(),
                    name: "read_file".to_string(),
                    arguments: json!({ "path": "a.rs" }),
                }]),
            },
            ChatMessage {
                role: ChatRole::Tool,
                content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                    tool_call_id: "ollama-read_file-0".to_string(),
                    content: "fn main() {}".to_string(),
                    is_error: false,
                }]),
            },
        ];

        let built = build_ollama_messages(&messages, Some("be brief"), &[]);

        assert_eq!(built[0]["role"], "system");
        assert_eq!(built[1]["tool_calls"][0]["function"]["name"], "read_file");
        // Native tool calls carry arguments as an OBJECT, not a JSON string.
        assert!(built[1]["tool_calls"][0]["function"]["arguments"].is_object());
        assert_eq!(built[2]["role"], "tool");
        assert_eq!(built[2]["tool_name"], "read_file");
        assert_eq!(built[2]["content"], "fn main() {}");
    }

    #[test]
    fn attachments_ride_as_bare_base64_images_on_the_last_user_message() {
        let messages = vec![
            ChatMessage {
                role: ChatRole::User,
                content: MessageContent::text("first"),
            },
            ChatMessage {
                role: ChatRole::User,
                content: MessageContent::text("look at this"),
            },
        ];
        let built = build_ollama_messages(
            &messages,
            None,
            &[ImageAttachment {
                media_type: "image/png".to_string(),
                data_base64: "AAAA".to_string(),
            }],
        );
        assert!(built[0].get("images").is_none());
        assert_eq!(built[1]["images"][0], "AAAA");
    }

    #[test]
    fn data_url_prefixes_are_stripped_for_the_native_api() {
        assert_eq!(bare_base64("data:image/png;base64,ZZZZ"), "ZZZZ");
        assert_eq!(bare_base64("ZZZZ"), "ZZZZ");
    }

    #[test]
    fn native_tool_calls_emit_start_delta_end_with_a_synthetic_id() {
        let chunks = native_tool_call_chunks(&[json!({
            "function": { "name": "get_weather", "arguments": { "city": "Tokyo" } }
        })]);
        assert_eq!(chunks.len(), 3);
        let (start_id, start_name) = match &chunks[0] {
            StreamChunk::ToolUseStart { id, name } => (id.clone(), name.clone()),
            other => panic!("expected ToolUseStart, got {:?}", other),
        };
        assert!(start_id.starts_with("ollama-get_weather-"));
        assert_eq!(start_name, "get_weather");
        match &chunks[2] {
            StreamChunk::ToolUseEnd {
                id,
                name,
                arguments,
            } => {
                assert_eq!(id, &start_id, "end must correlate with start");
                assert_eq!(name, "get_weather");
                assert_eq!(arguments["city"], "Tokyo");
            }
            other => panic!("expected ToolUseEnd, got {:?}", other),
        }
    }

    #[test]
    fn estimate_counts_message_text_not_json_scaffolding() {
        let messages = vec![json!({ "role": "user", "content": "x".repeat(4_000) })];
        let estimate = estimate_prompt_tokens(&messages, &[]);
        // ~1000 tokens for 4000 chars, plus the tiny role strings.
        assert!((1_000..1_010).contains(&estimate), "got {estimate}");
    }

    /// A base64 screenshot is ~1 MB of characters and a few hundred tokens.
    /// Counting it as text would fire the overflow warning on every image.
    #[test]
    fn estimate_ignores_base64_image_blobs() {
        let with_image = vec![json!({
            "role": "user",
            "content": "what is this",
            "images": ["A".repeat(1_000_000)],
        })];
        assert!(
            estimate_prompt_tokens(&with_image, &[]) < 20,
            "images must not be counted as prompt text"
        );
    }
}
