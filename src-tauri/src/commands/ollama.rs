//! Ollama local-model discovery.
//!
//! Queries `GET {base}/api/tags` to list the models the user has pulled
//! locally. The base URL mirrors the logic in `core::llm_ollama`: the saved
//! provider endpoint wins, then `PACKETADE_OLLAMA_URL`, then the legacy
//! `PACKETCODE_OLLAMA_URL`, then `http://localhost:11434`. Any trailing
//! `/v1` is stripped — `/api/tags` lives at the base URL, not under the
//! OpenAI-compatible `/v1/*` namespace.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// A model the Ollama daemon has available locally.
#[derive(Serialize, Clone, Debug)]
pub struct OllamaModel {
    /// Fully qualified model tag, e.g. `"llama3.3:70b"`.
    pub name: String,
    /// Size on disk in bytes, if the daemon reported it.
    pub size: Option<u64>,
    /// RFC3339 timestamp of the last modification, if reported.
    pub modified_at: Option<String>,
    /// Whether the model can call tools. `Some(false)` disables the row in
    /// tool-carrying pickers; `None` means the daemon did not say (old
    /// daemons) and must NOT disable anything — the backend pre-flight in
    /// `core::llm_ollama` stays the enforcement point.
    #[serde(rename = "supportsTools")]
    pub supports_tools: Option<bool>,
    /// Trained context window in tokens, when the daemon reported it.
    #[serde(rename = "contextLength")]
    pub context_length: Option<u32>,
}

/// Raw `/api/tags` response shape.
#[derive(Deserialize)]
struct TagsResponse {
    models: Option<Vec<TagsEntry>>,
}

/// One `/api/tags` row. Ollama v0.32+ reports `capabilities` and
/// `details.context_length` inline, sparing us an `/api/show` per model;
/// older daemons omit both.
#[derive(Deserialize)]
struct TagsEntry {
    name: String,
    size: Option<u64>,
    modified_at: Option<String>,
    #[allow(dead_code)]
    digest: Option<String>,
    capabilities: Option<Vec<String>>,
    details: Option<TagsDetails>,
}

#[derive(Deserialize)]
struct TagsDetails {
    context_length: Option<u32>,
}

/// Convert one tags row into the wire model. Pure so the with/without-
/// capabilities shapes are testable against fixtures. Capabilities present →
/// tool support is decided here (v0.32+ path, zero extra round trips);
/// absent → `supports_tools: None`, and the caller may fan out to
/// `/api/show` to fill it in.
fn model_from_tags_entry(entry: TagsEntry) -> OllamaModel {
    let supports_tools = entry
        .capabilities
        .as_ref()
        .map(|caps| caps.iter().any(|c| c == "tools"));
    let context_length = entry
        .details
        .as_ref()
        .and_then(|d| d.context_length)
        .filter(|len| *len > 0);
    OllamaModel {
        name: entry.name,
        size: entry.size,
        modified_at: entry.modified_at,
        supports_tools,
        context_length,
    }
}

pub(crate) fn resolve_base_url() -> String {
    crate::core::storage::resolve_ollama_root_base_url()
}

#[tauri::command]
pub fn get_ollama_base_url() -> Result<String, String> {
    Ok(resolve_base_url())
}

#[tauri::command]
pub fn set_ollama_base_url(base_url: Option<String>) -> Result<String, String> {
    let normalized = base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::core::storage::normalize_ollama_root_base_url)
        .transpose()?;

    crate::core::storage::save_ollama_base_url(normalized)?;
    Ok(resolve_base_url())
}

/// The two local-runtime knobs that decide whether Ollama sees the context we
/// think we sent. Both are sent on the native `/api/chat` route; neither can be
/// expressed on the OpenAI-compatible one.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRuntimeOptions {
    /// Ceiling on `options.num_ctx`. The model's own trained window still wins
    /// when it is smaller.
    pub num_ctx_cap: u32,
    /// `keep_alive` value sent with every request.
    pub keep_alive: String,
    /// The built-in default cap, so the UI can label the reset affordance.
    pub default_num_ctx_cap: u32,
    /// The built-in default keep-alive.
    pub default_keep_alive: String,
}

fn current_runtime_options() -> OllamaRuntimeOptions {
    OllamaRuntimeOptions {
        num_ctx_cap: crate::core::llm_ollama::resolve_num_ctx_cap(),
        keep_alive: crate::core::llm_ollama::resolve_keep_alive(),
        default_num_ctx_cap: crate::core::llm_ollama::DEFAULT_NUM_CTX_CAP,
        default_keep_alive: crate::core::llm_ollama::DEFAULT_KEEP_ALIVE.to_string(),
    }
}

#[tauri::command]
pub fn get_ollama_runtime_options() -> Result<OllamaRuntimeOptions, String> {
    Ok(current_runtime_options())
}

/// Save both knobs. A `None` (or blank/zero) field clears that override and
/// restores the built-in default.
#[tauri::command]
pub fn set_ollama_runtime_options(
    num_ctx_cap: Option<u32>,
    keep_alive: Option<String>,
) -> Result<OllamaRuntimeOptions, String> {
    let cap = match num_ctx_cap.filter(|cap| *cap > 0) {
        Some(cap) if cap < crate::core::llm_ollama::MIN_NUM_CTX_CAP => {
            return Err(format!(
                "Context cap must be at least {} tokens.",
                crate::core::llm_ollama::MIN_NUM_CTX_CAP
            ))
        }
        other => other,
    };
    let keep_alive = keep_alive
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::core::llm_ollama::normalize_keep_alive)
        .transpose()?;

    crate::core::storage::save_ollama_runtime_options(cap, keep_alive)?;
    Ok(current_runtime_options())
}

#[tauri::command]
pub async fn list_ollama_models() -> Result<Vec<OllamaModel>, String> {
    let base = resolve_base_url();
    let url = format!("{}/api/tags", base);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2000))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            format!("Ollama not reachable at {}", base)
        } else {
            format!("Failed to reach Ollama: {}", e)
        }
    })?;

    if !resp.status().is_success() {
        return Err(format!(
            "Ollama returned HTTP {} from {}",
            resp.status(),
            url
        ));
    }

    let parsed: TagsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama /api/tags response: {}", e))?;

    let mut models: Vec<OllamaModel> = parsed
        .models
        .unwrap_or_default()
        .into_iter()
        .map(model_from_tags_entry)
        .collect();

    // Old daemons omit `capabilities` from /api/tags entirely. Fan out to
    // `/api/show` (bounded, memoised per process in llm_ollama's profile
    // cache) so the picker can still gate tool-less models. A probe failure
    // leaves the field `None`, which renders as "unknown" and never disables
    // a row.
    const MAX_SHOW_PROBES: usize = 8;
    let missing: Vec<usize> = models
        .iter()
        .enumerate()
        .filter(|(_, m)| m.supports_tools.is_none())
        .map(|(i, _)| i)
        .take(MAX_SHOW_PROBES)
        .collect();
    if !missing.is_empty() {
        let probes = missing.iter().map(|&i| {
            let name = models[i].name.clone();
            let base = base.clone();
            async move {
                (
                    i,
                    crate::core::llm_ollama::fetch_model_profile(&base, &name).await,
                )
            }
        });
        for (i, profile) in futures::future::join_all(probes).await {
            if let Some(profile) = profile {
                models[i].supports_tools = profile.supports_tools();
                if models[i].context_length.is_none() {
                    models[i].context_length = profile.context_length;
                }
            }
        }
    }

    Ok(models)
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use super::{model_from_tags_entry, TagsResponse};

    /// Fixture from a live Ollama v0.32.15 `/api/tags` answer (fields we do
    /// not model trimmed): per-model `capabilities` + `details.context_length`
    /// are present.
    const TAGS_V0_32: &str = r#"{
        "models": [
            {
                "name": "qwen2.5-coder:7b",
                "size": 4683087519,
                "modified_at": "2026-08-10T11:22:33.000000000Z",
                "digest": "2b0496514337a3d6901a1a1a1a1a1a1a",
                "details": { "format": "gguf", "context_length": 32768 },
                "capabilities": ["completion", "tools", "insert"]
            },
            {
                "name": "nomic-embed-text:latest",
                "size": 274302450,
                "modified_at": "2026-08-10T11:00:00.000000000Z",
                "digest": "0a109f422b47a3d6901a1a1a1a1a1a1a",
                "details": { "format": "gguf", "context_length": 2048 },
                "capabilities": ["embedding"]
            }
        ]
    }"#;

    /// Fixture in the pre-capabilities shape old daemons still serve.
    const TAGS_LEGACY: &str = r#"{
        "models": [
            { "name": "llama3:8b", "size": 4661224676, "modified_at": "2025-01-01T00:00:00Z" }
        ]
    }"#;

    #[test]
    fn tags_with_capabilities_decide_tool_support_inline() {
        let parsed: TagsResponse = serde_json::from_str(TAGS_V0_32).unwrap();
        let models: Vec<_> = parsed
            .models
            .unwrap()
            .into_iter()
            .map(model_from_tags_entry)
            .collect();

        assert_eq!(models[0].name, "qwen2.5-coder:7b");
        assert_eq!(models[0].supports_tools, Some(true));
        assert_eq!(models[0].context_length, Some(32768));

        // Capabilities present but no "tools" → definitively not tool-capable.
        assert_eq!(models[1].supports_tools, Some(false));
        assert_eq!(models[1].context_length, Some(2048));
    }

    #[test]
    fn tags_without_capabilities_stay_unknown_not_disabled() {
        let parsed: TagsResponse = serde_json::from_str(TAGS_LEGACY).unwrap();
        let models: Vec<_> = parsed
            .models
            .unwrap()
            .into_iter()
            .map(model_from_tags_entry)
            .collect();
        // `None` = "the daemon did not say" — must never render as disabled.
        assert_eq!(models[0].supports_tools, None);
        assert_eq!(models[0].context_length, None);
        assert_eq!(models[0].size, Some(4_661_224_676));
    }

    #[test]
    fn wire_shape_uses_camel_case_for_new_fields() {
        let parsed: TagsResponse = serde_json::from_str(TAGS_V0_32).unwrap();
        let entry = parsed.models.unwrap().into_iter().next().unwrap();
        let model = model_from_tags_entry(entry);
        let json = serde_json::to_value(&model).unwrap();
        assert_eq!(json["supportsTools"], serde_json::json!(true));
        assert_eq!(json["contextLength"], serde_json::json!(32768));
        // Pre-existing fields keep their historical snake_case names.
        assert!(json.get("modified_at").is_some());
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn default_root_base_url_is_localhost() {
        let _guard = env_lock().lock().unwrap();
        assert_eq!(
            crate::core::storage::DEFAULT_OLLAMA_ROOT_BASE_URL,
            "http://localhost:11434"
        );
    }

    #[test]
    fn normalize_root_base_url_strips_v1() {
        let _guard = env_lock().lock().unwrap();
        assert_eq!(
            crate::core::storage::normalize_ollama_root_base_url("http://new.example.com:9999/v1")
                .unwrap(),
            "http://new.example.com:9999"
        );
    }

    #[test]
    fn normalize_root_base_url_strips_api_tags() {
        let _guard = env_lock().lock().unwrap();
        assert_eq!(
            crate::core::storage::normalize_ollama_root_base_url(
                "http://new.example.com:9999/api/tags"
            )
            .unwrap(),
            "http://new.example.com:9999"
        );
    }

    #[test]
    fn normalize_root_base_url_strips_trailing_slash() {
        let _guard = env_lock().lock().unwrap();
        assert_eq!(
            crate::core::storage::normalize_ollama_root_base_url("http://example.com:9999/")
                .unwrap(),
            "http://example.com:9999"
        );
    }

    #[test]
    fn normalize_root_base_url_rejects_query_and_fragment() {
        let _guard = env_lock().lock().unwrap();
        assert!(crate::core::storage::normalize_ollama_root_base_url(
            "http://example.com:9999?x=1"
        )
        .is_err());
        assert!(crate::core::storage::normalize_ollama_root_base_url(
            "http://example.com:9999/#models"
        )
        .is_err());
    }

    #[test]
    fn normalize_root_base_url_rejects_non_http_urls() {
        let _guard = env_lock().lock().unwrap();
        assert!(
            crate::core::storage::normalize_ollama_root_base_url("file:///tmp/ollama").is_err()
        );
    }
}
