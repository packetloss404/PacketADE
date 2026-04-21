//! Ollama local-model discovery.
//!
//! Queries `GET {base}/api/tags` to list the models the user has pulled
//! locally. The base URL mirrors the logic in `core::llm_ollama`:
//! default `http://localhost:11434`, overridable via the
//! `PACKETCODE_OLLAMA_URL` env var. Any trailing `/v1` on the override is
//! stripped — `/api/tags` lives at the base URL, not under the
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

fn resolve_base_url() -> String {
    let raw = std::env::var("PACKETCODE_OLLAMA_URL")
        .unwrap_or_else(|_| "http://localhost:11434".to_string());
    // Strip trailing `/v1` (OpenAI-compat chat endpoint lives there, but
    // `/api/tags` is at the root) and any trailing slash.
    let trimmed = raw.trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    trimmed.trim_end_matches('/').to_string()
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
            "Ollama not running on localhost:11434".to_string()
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
    use super::*;

    #[test]
    fn resolve_base_url_default() {
        // Make sure the env var is unset for this test.
        std::env::remove_var("PACKETCODE_OLLAMA_URL");
        assert_eq!(resolve_base_url(), "http://localhost:11434");
    }

    #[test]
    fn resolve_base_url_strips_trailing_v1() {
        std::env::set_var("PACKETCODE_OLLAMA_URL", "http://example.com:9999/v1");
        assert_eq!(resolve_base_url(), "http://example.com:9999");
        std::env::remove_var("PACKETCODE_OLLAMA_URL");
    }

    #[test]
    fn resolve_base_url_strips_trailing_slash() {
        std::env::set_var("PACKETCODE_OLLAMA_URL", "http://example.com:9999/");
        assert_eq!(resolve_base_url(), "http://example.com:9999");
        std::env::remove_var("PACKETCODE_OLLAMA_URL");
    }
}
