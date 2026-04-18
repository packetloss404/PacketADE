//! OpenRouter API provider (OpenAI-compatible with extra headers).

use crate::core::brand::{APP_NAME, BRAND_URL};
use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::*;
use reqwest::header::{HeaderMap, HeaderValue};
use tokio::sync::mpsc;

const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

pub struct OpenRouterProvider;

#[async_trait::async_trait]
impl LlmProvider for OpenRouterProvider {
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "HTTP-Referer",
            HeaderValue::from_static(BRAND_URL),
        );
        headers.insert("X-Title", HeaderValue::from_static(APP_NAME));

        let config = OpenAiCompatConfig {
            base_url: OPENROUTER_BASE_URL.to_string(),
            headers,
            provider_id: "openrouter".to_string(),
        };
        stream_chat_compat(&config, api_key, request, tx).await
    }

    fn provider_id(&self) -> &str {
        "openrouter"
    }
}
