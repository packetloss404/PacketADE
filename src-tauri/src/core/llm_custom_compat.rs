//! LM2 — user-supplied OpenAI-compatible endpoint provider ("custom").
//!
//! Covers vLLM, LM Studio, LiteLLM, Together, and any other server that
//! speaks `POST {base}/chat/completions`. The base URL is configured in
//! Settings → Tools → Provider Endpoints and stored INCLUDING its path
//! prefix (typically `/v1`) — see
//! [`crate::core::storage::normalize_custom_compat_base_url`].
//!
//! The API key is optional: many local/self-hosted servers require none.
//! [`crate::commands::api_keys::load_api_key`] returns an empty string when
//! the `api-key-custom` keyring slot is empty, and
//! [`crate::core::llm_openai_compat::stream_chat_compat`] skips the
//! `Authorization` header for an empty key.

use reqwest::header::HeaderMap;
use tokio::sync::mpsc;

use crate::core::llm_openai_compat::{stream_chat_compat, OpenAiCompatConfig};
use crate::core::llm_provider::LlmProvider;
use crate::core::llm_types::{LlmRequest, StreamChunk};

/// User-facing pointer for the unconfigured state, shared with the auth
/// probe so both paths tell the same story.
pub const CUSTOM_ENDPOINT_UNSET_HINT: &str =
    "Set the endpoint URL in Settings → Tools → Provider Endpoints";

pub struct CustomCompatProvider;

#[async_trait::async_trait]
impl LlmProvider for CustomCompatProvider {
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String> {
        let base_url = crate::core::storage::resolve_custom_compat_base_url().ok_or_else(|| {
            format!(
                "No custom OpenAI-compatible endpoint is configured. {}.",
                CUSTOM_ENDPOINT_UNSET_HINT
            )
        })?;
        let config = OpenAiCompatConfig {
            base_url,
            headers: HeaderMap::new(),
            provider_id: "custom".to_string(),
        };
        stream_chat_compat(&config, api_key, request, tx).await
    }

    fn provider_id(&self) -> &str {
        "custom"
    }
}
