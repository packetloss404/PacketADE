//! Ollama provider (local, OpenAI-compatible endpoint, no API key).

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

const DEFAULT_OLLAMA_BASE_URL: &str = "http://localhost:11434/v1";

pub struct OllamaProvider;

impl OllamaProvider {
    fn base_url(&self) -> String {
        // Allow override via environment variable
        std::env::var("PACKETCODE_OLLAMA_URL")
            .unwrap_or_else(|_| DEFAULT_OLLAMA_BASE_URL.to_string())
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
