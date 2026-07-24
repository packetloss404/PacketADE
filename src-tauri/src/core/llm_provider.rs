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
    /// Must send `StreamChunk::Done`, send `StreamChunk::Error`, or return an
    /// error for the caller to surface.
    async fn stream_chat(
        &self,
        api_key: &str,
        request: LlmRequest,
        tx: mpsc::Sender<StreamChunk>,
    ) -> Result<(), String>;

    /// Return the provider identifier (e.g., "anthropic", "openai").
    fn provider_id(&self) -> &str;
}

/// Turn a non-empty EOF remainder into one normal parser line. SSE streams do
/// not require the final record to end in a newline.
pub(crate) fn delimit_final_sse_line(buffer: &mut Vec<u8>) {
    if !buffer.is_empty() && !buffer.ends_with(b"\n") {
        buffer.push(b'\n');
    }
}

/// Get a provider instance by name.
pub fn get_provider(name: &str) -> Result<Box<dyn LlmProvider>, String> {
    match name {
        "anthropic" => Ok(Box::new(super::llm_anthropic::AnthropicProvider)),
        "openai" => Ok(Box::new(super::llm_openai::OpenAiProvider)),
        // Token Plan and pay-as-you-go API both use the same OpenAI-compatible
        // MiniMax endpoint; they differ only by which keyring key supplies the
        // credential (provider string -> `api-key-{provider}`).
        "minimax" | "minimax-api" => Ok(Box::new(super::llm_minimax::MiniMaxProvider)),
        "openrouter" => Ok(Box::new(super::llm_openrouter::OpenRouterProvider)),
        "ollama" => Ok(Box::new(super::llm_ollama::OllamaProvider)),
        _ => Err(format!("Unknown provider: {}", name)),
    }
}

#[cfg(test)]
mod tests {
    use super::delimit_final_sse_line;

    #[test]
    fn final_sse_record_without_newline_gets_parser_delimiter() {
        let mut buffer = b"data: {\"type\":\"message_stop\"}".to_vec();
        delimit_final_sse_line(&mut buffer);
        assert!(buffer.ends_with(b"\n"));
        assert_eq!(buffer.iter().filter(|byte| **byte == b'\n').count(), 1);
    }

    #[test]
    fn empty_or_already_delimited_sse_buffer_is_unchanged() {
        let mut empty = Vec::new();
        delimit_final_sse_line(&mut empty);
        assert!(empty.is_empty());

        let mut complete = b"data: [DONE]\n".to_vec();
        delimit_final_sse_line(&mut complete);
        assert_eq!(complete, b"data: [DONE]\n");
    }
}
