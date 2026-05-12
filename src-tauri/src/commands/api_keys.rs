//! API key management for LLM providers using the OS credential store.

use crate::core::brand::{KEYRING_SERVICE, LEGACY_KEYRING_SERVICE};
use tracing::{info, warn};

const VALID_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "minimax",
    "openrouter",
    "ollama",
    "gemini",
];

fn validate_provider(provider: &str) -> Result<(), String> {
    if !VALID_PROVIDERS.contains(&provider) {
        return Err(format!(
            "Unknown provider '{}'. Valid: {}",
            provider,
            VALID_PROVIDERS.join(", ")
        ));
    }
    Ok(())
}

fn keyring_entry(provider: &str) -> Option<keyring::Entry> {
    match keyring::Entry::new(KEYRING_SERVICE, &format!("api-key-{}", provider)) {
        Ok(entry) => Some(entry),
        Err(e) => {
            warn!("Failed to create keyring entry for {}: {}", provider, e);
            None
        }
    }
}

/// Legacy keyring entry for one-shot migration from the old "packetcode" service.
fn legacy_keyring_entry(provider: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(LEGACY_KEYRING_SERVICE, &format!("api-key-{}", provider)).ok()
}

/// Load an API key for a provider. Internal only — not exposed to frontend.
pub fn load_api_key(provider: &str) -> Result<String, String> {
    if provider == "ollama" {
        // Ollama doesn't need an API key
        return Ok(String::new());
    }

    let entry = keyring_entry(provider)
        .ok_or_else(|| format!("Credential store unavailable for {}", provider))?;

    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            // Fall back to the legacy "packetcode" keyring service and migrate on success.
            if let Some(legacy) = legacy_keyring_entry(provider) {
                if let Ok(key) = legacy.get_password() {
                    let _ = entry.set_password(&key);
                    let _ = legacy.delete_credential();
                    info!(provider = %provider, "Migrated API key from legacy keyring service");
                    return Ok(key);
                }
            }
            Err(format!("No API key configured for {}. Set one in Settings > API Keys.", provider))
        }
        Err(e) => Err(format!("Failed to read API key for {}: {}", provider, e)),
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;

    if provider == "ollama" {
        return Err("Ollama does not require an API key.".to_string());
    }

    if key.trim().is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let entry = keyring_entry(&provider)
        .ok_or_else(|| "Credential store unavailable".to_string())?;

    entry
        .set_password(key.trim())
        .map_err(|e| format!("Failed to store API key: {}", e))?;

    info!(provider = %provider, "API key stored");
    Ok(())
}

#[tauri::command]
pub async fn get_api_key_exists(provider: String) -> Result<bool, String> {
    validate_provider(&provider)?;

    if provider == "ollama" {
        return Ok(true); // Ollama doesn't need a key
    }

    let entry = match keyring_entry(&provider) {
        Some(e) => e,
        None => return Ok(false),
    };

    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => {
            // Check legacy keyring service; don't migrate here (read-only path).
            if let Some(legacy) = legacy_keyring_entry(&provider) {
                if legacy.get_password().is_ok() {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Err(e) => {
            warn!("Error checking API key for {}: {}", provider, e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn delete_api_key(provider: String) -> Result<(), String> {
    validate_provider(&provider)?;

    if provider == "ollama" {
        return Ok(());
    }

    let entry = match keyring_entry(&provider) {
        Some(e) => e,
        None => return Ok(()),
    };

    match entry.delete_credential() {
        Ok(()) => {
            info!(provider = %provider, "API key deleted");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete API key: {}", e)),
    }
}
