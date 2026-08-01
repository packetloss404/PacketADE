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
}

/// Raw `/api/tags` response shape. Only the fields we care about — digest
/// and details are dropped.
#[derive(Deserialize)]
struct TagsResponse {
    models: Option<Vec<TagsEntry>>,
}

#[derive(Deserialize)]
struct TagsEntry {
    name: String,
    size: Option<u64>,
    modified_at: Option<String>,
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

    let models = parsed
        .models
        .unwrap_or_default()
        .into_iter()
        .map(|m| OllamaModel {
            name: m.name,
            size: m.size,
            modified_at: m.modified_at,
        })
        .collect();

    Ok(models)
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

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
