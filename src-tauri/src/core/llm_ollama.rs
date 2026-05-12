//! Ollama provider (local, OpenAI-compatible endpoint, no API key).

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434/v1";

fn resolve_base_url() -> String {
    std::env::var("PACKETADE_OLLAMA_URL")
        .or_else(|_| std::env::var("PACKETCODE_OLLAMA_URL"))
        .unwrap_or_else(|_| DEFAULT_OLLAMA_BASE_URL.to_string())
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
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn resolve_base_url_defaults_to_ollama_v1() {
        let _guard = env_lock().lock().unwrap();
        std::env::remove_var("PACKETADE_OLLAMA_URL");
        std::env::remove_var("PACKETCODE_OLLAMA_URL");
        assert_eq!(resolve_base_url(), DEFAULT_OLLAMA_BASE_URL);
    }

    #[test]
    fn resolve_base_url_prefers_packetade_env() {
        let _guard = env_lock().lock().unwrap();
        std::env::set_var("PACKETADE_OLLAMA_URL", "http://new.example.com:11434/v1");
        std::env::set_var(
            "PACKETCODE_OLLAMA_URL",
            "http://legacy.example.com:11434/v1",
        );
        assert_eq!(resolve_base_url(), "http://new.example.com:11434/v1");
        std::env::remove_var("PACKETADE_OLLAMA_URL");
        std::env::remove_var("PACKETCODE_OLLAMA_URL");
    }

    #[test]
    fn resolve_base_url_falls_back_to_legacy_env() {
        let _guard = env_lock().lock().unwrap();
        std::env::remove_var("PACKETADE_OLLAMA_URL");
        std::env::set_var(
            "PACKETCODE_OLLAMA_URL",
            "http://legacy.example.com:11434/v1",
        );
        assert_eq!(resolve_base_url(), "http://legacy.example.com:11434/v1");
        std::env::remove_var("PACKETCODE_OLLAMA_URL");
    }
}
