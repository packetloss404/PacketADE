//! MiniMax API provider (OpenAI-compatible endpoint).

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

/// Resolve the MiniMax OpenAI-compatible endpoint.
///
/// Defaults to the documented **global** host `https://api.minimax.io/v1`.
/// Mainland-China accounts are served from `https://api.minimaxi.com/v1`, so
/// this is overridable exactly like Ollama's base URL: the saved provider
/// endpoint wins, then `PACKETADE_MINIMAX_URL`, then the default.
///
/// (The previous hardcoded `https://api.minimaxi.chat/v1` is a legacy host that
/// appears nowhere in MiniMax's current documentation.)
fn resolve_base_url() -> String {
    crate::core::storage::resolve_minimax_base_url()
}

pub struct MiniMaxProvider;

#[async_trait::async_trait]
impl LlmProvider for MiniMaxProvider {
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        let config = OpenAiCompatConfig {
            base_url: resolve_base_url(),
            headers: HeaderMap::new(),
            provider_id: "minimax".to_string(),
        };
        stream_chat_compat(&config, api_key, request, tx).await
    }

    fn provider_id(&self) -> &str {
        "minimax"
    }
}

#[cfg(test)]
mod tests {
    use crate::core::storage::{normalize_minimax_base_url, DEFAULT_MINIMAX_BASE_URL};

    #[test]
    fn default_is_the_documented_global_host() {
        assert_eq!(DEFAULT_MINIMAX_BASE_URL, "https://api.minimax.io/v1");
    }

    #[test]
    fn mainland_china_host_is_accepted_verbatim() {
        assert_eq!(
            normalize_minimax_base_url("https://api.minimaxi.com/v1").unwrap(),
            "https://api.minimaxi.com/v1"
        );
    }

    #[test]
    fn bare_host_gains_the_v1_suffix() {
        assert_eq!(
            normalize_minimax_base_url("https://api.minimaxi.com").unwrap(),
            "https://api.minimaxi.com/v1"
        );
        assert_eq!(
            normalize_minimax_base_url("https://api.minimax.io/v1/").unwrap(),
            "https://api.minimax.io/v1"
        );
    }

    #[test]
    fn rejects_malformed_urls() {
        assert!(normalize_minimax_base_url("api.minimax.io").is_err());
        assert!(normalize_minimax_base_url("").is_err());
        assert!(normalize_minimax_base_url("file:///tmp/minimax").is_err());
    }
}
