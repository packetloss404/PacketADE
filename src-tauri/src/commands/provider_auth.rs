use crate::commands::api_keys::get_api_key_exists;
use std::time::Duration;

#[derive(serde::Serialize)]
pub struct ProviderAuthStatus {
    pub status: String,
    pub hint: String,
}

#[tauri::command]
pub async fn get_provider_auth_status(provider: String) -> Result<ProviderAuthStatus, String> {
    match provider.as_str() {
        "anthropic" | "openai" | "minimax" | "openrouter" => {
            let exists = get_api_key_exists(provider.clone()).await?;
            if exists {
                Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint: String::new(),
                })
            } else {
                let label = match provider.as_str() {
                    "anthropic" => "Anthropic",
                    "openai" => "OpenAI",
                    "minimax" => "MiniMax",
                    "openrouter" => "OpenRouter",
                    _ => &provider,
                };
                Ok(ProviderAuthStatus {
                    status: "missing_key".to_string(),
                    hint: format!("Add your {} API key in Tools → API Keys", label),
                })
            }
        }
        "ollama" => {
            let base_url = std::env::var("PACKETCODE_OLLAMA_URL")
                .unwrap_or_else(|_| "http://localhost:11434".to_string());
            let url = format!("{}/api/tags", base_url.trim_end_matches("/v1").trim_end_matches('/'));
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(500))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => Ok(ProviderAuthStatus {
                    status: "ready".to_string(),
                    hint: String::new(),
                }),
                _ => Ok(ProviderAuthStatus {
                    status: "service_down".to_string(),
                    hint: "Ollama not running on localhost:11434".to_string(),
                }),
            }
        }
        "claude-oauth" => Ok(ProviderAuthStatus {
            status: "coming_soon".to_string(),
            hint: "Available in Phase 4".to_string(),
        }),
        "openai-codex" => Ok(ProviderAuthStatus {
            status: "coming_soon".to_string(),
            hint: "Available in Phase 5".to_string(),
        }),
        other => Err(format!("Unknown provider '{}'", other)),
    }
}
