use crate::core::llm_types::{LlmRequest, StreamChunk};
use tokio::sync::mpsc;

/// Trait implemented by each LLM provider (Anthropic, OpenAI, etc.).
///
/// Providers stream response chunks through the provided channel sender.
/// The caller listens on the receiver and emits Tauri events accordingly.
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// Stream a chat completion response.
    ///
    /// Sends `StreamChunk` variants through `tx` as they arrive.
    /// Must send `StreamChunk::Done` or `StreamChunk::Error` before returning.
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String>;

    /// Return the provider identifier (e.g., "anthropic", "openai").
    fn provider_id(&self) -> &str;
}

/// Get a provider instance by name.
pub fn get_provider(name: &str) -> Result<Box<dyn LlmProvider>, String> {
    match name {
        "anthropic" => Ok(Box::new(super::llm_anthropic::AnthropicProvider)),
        "openai" => Ok(Box::new(super::llm_openai::OpenAiProvider)),
        "minimax" => Ok(Box::new(super::llm_minimax::MiniMaxProvider)),
        "openrouter" => Ok(Box::new(super::llm_openrouter::OpenRouterProvider)),
        "ollama" => Ok(Box::new(super::llm_ollama::OllamaProvider)),
        _ => Err(format!("Unknown provider: {}", name)),
    }
}
