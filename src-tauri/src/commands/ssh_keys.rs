//! SSH password storage in the OS credential store, keyed by SSH target id.

use crate::core::brand::{KEYRING_SERVICE, LEGACY_KEYRING_SERVICE};
use tracing::{info, warn};

fn keyring_entry_for(service: &str, target_id: &str) -> Option<keyring::Entry> {
    match keyring::Entry::new(service, &format!("ssh-{}", target_id)) {
        Ok(entry) => Some(entry),
        Err(e) => {
            warn!(
                "Failed to create keyring entry for ssh target {}: {}",
                target_id, e
            );
            None
        }
    }
}

fn keyring_entry(target_id: &str) -> Option<keyring::Entry> {
    keyring_entry_for(KEYRING_SERVICE, target_id)
}

fn legacy_keyring_entry(target_id: &str) -> Option<keyring::Entry> {
    keyring_entry_for(LEGACY_KEYRING_SERVICE, target_id)
}

/// Load an SSH password for a target. Internal only — not exposed to frontend.
/// Returns Ok(None) when no password is stored (e.g. key-based auth).
/// Used by `tool_runtime_ssh` when it runs commands on a remote host.
pub fn load_ssh_password(target_id: &str) -> Result<Option<String>, String> {
    let entry = match keyring_entry(target_id) {
        Some(e) => e,
        None => return Ok(None),
    };
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => {
            if let Some(legacy) = legacy_keyring_entry(target_id) {
                if let Ok(pw) = legacy.get_password() {
                    let _ = entry.set_password(&pw);
                    let _ = legacy.delete_credential();
                    info!(target = %target_id, "Migrated SSH password from legacy keyring service");
                    return Ok(Some(pw));
                }
            }
            Ok(None)
        }
        Err(e) => Err(format!("Failed to read SSH password: {}", e)),
    }
}

#[tauri::command]
pub async fn set_ssh_password(target_id: String, password: String) -> Result<(), String> {
    if target_id.trim().is_empty() {
        return Err("target_id cannot be empty".to_string());
    }
    let entry =
        keyring_entry(&target_id).ok_or_else(|| "Credential store unavailable".to_string())?;
    entry
        .set_password(&password)
        .map_err(|e| format!("Failed to store SSH password: {}", e))?;
    info!(target = %target_id, "SSH password stored");
    Ok(())
}

#[tauri::command]
pub async fn delete_ssh_password(target_id: String) -> Result<(), String> {
    let mut first_error: Option<String> = None;
    let mut deleted = false;
    for entry in [keyring_entry(&target_id), legacy_keyring_entry(&target_id)]
        .into_iter()
        .flatten()
    {
        match entry.delete_credential() {
            Ok(()) => deleted = true,
            Err(keyring::Error::NoEntry) => {}
            Err(e) if first_error.is_none() => first_error = Some(e.to_string()),
            Err(_) => {}
        }
    }
    if let Some(e) = first_error {
        Err(format!("Failed to delete SSH password: {}", e))
    } else {
        if deleted {
            info!(target = %target_id, "SSH password deleted");
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn get_ssh_password_exists(target_id: String) -> Result<bool, String> {
    let entry = match keyring_entry(&target_id) {
        Some(e) => e,
        None => return Ok(false),
    };
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => {
            if let Some(legacy) = legacy_keyring_entry(&target_id) {
                return Ok(legacy.get_password().is_ok());
            }
            Ok(false)
        }
        Err(_) => Ok(false),
    }
}
