use crate::commands::api_keys::get_api_key_exists;
use std::time::Duration;

/// Probe whether the user has logged into Claude Code (`claude login`).
///
/// Claude Code stores OAuth credentials in `~/.claude/credentials` on some
/// platforms/versions and `~/.claude/.credentials.json` on others, so we
/// check both paths. Presence + non-empty is enough for v1.
///
/// TODO: parse the credentials file and surface expiry — expired tokens
/// should probably report `login_required` with a "session expired" hint.
fn probe_claude_oauth() -> ProviderAuthStatus {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return ProviderAuthStatus {
                status: "login_required".to_string(),
                hint: "Run `claude login` in a terminal".to_string(),
            };
        }
    };
    let candidates = [
        home.join(".claude").join("credentials"),
        home.join(".claude").join(".credentials.json"),
    ];
    let mut any_found = false;
    for path in &candidates {
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() => {
                any_found = true;
                if meta.len() > 0 {
                    return ProviderAuthStatus {
                        status: "ready".to_string(),
                        hint: String::new(),
                    };
                }
            }
            Ok(_) => {
                // Exists but isn't a regular file — treat as unreadable.
                any_found = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return ProviderAuthStatus {
                    status: "login_required".to_string(),
                    hint: "Claude credentials unreadable".to_string(),
                };
            }
        }
    }
    if any_found {
        // Found but empty / not a regular file.
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Claude credentials unreadable".to_string(),
        }
    } else {
        ProviderAuthStatus {
            status: "login_required".to_string(),
            hint: "Run `claude login` in a terminal".to_string(),
        }
    }
}

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
        "claude-oauth" => Ok(probe_claude_oauth()),
        "openai-codex" => Ok(ProviderAuthStatus {
            status: "coming_soon".to_string(),
            hint: "Available in Phase 5".to_string(),
        }),
        other => Err(format!("Unknown provider '{}'", other)),
    }
}
