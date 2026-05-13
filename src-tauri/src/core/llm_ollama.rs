//! Ollama provider (local, OpenAI-compatible endpoint, no API key).

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

fn resolve_base_url() -> String {
    crate::core::storage::resolve_ollama_openai_base_url()
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
        let config = OpenAiCompatConfig {
            base_url: self.base_url(),
            headers: HeaderMap::new(),
            provider_id: "ollama".to_string(),
        };
        // Ollama doesn't need an API key, pass empty string
        stream_chat_compat(&config, "", request, tx).await
    }

    fn provider_id(&self) -> &str {
        "ollama"
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
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
}
