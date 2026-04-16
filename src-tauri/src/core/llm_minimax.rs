//! MiniMax API provider (OpenAI-compatible endpoint).

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

const MINIMAX_BASE_URL: &str = "https://api.minimaxi.chat/v1";

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
            base_url: MINIMAX_BASE_URL.to_string(),
            headers: HeaderMap::new(),
            provider_id: "minimax".to_string(),
        };
        stream_chat_compat(&config, api_key, request, tx).await
    }

    fn provider_id(&self) -> &str {
        "minimax"
    }
}
