//! SSH password storage in the OS credential store, keyed by SSH target id.

use tracing::{info, warn};

fn keyring_entry(target_id: &str) -> Option<keyring::Entry> {
    match keyring::Entry::new("packetcode", &format!("ssh-{}", target_id)) {
        Ok(entry) => Some(entry),
        Err(e) => {
            warn!("Failed to create keyring entry for ssh target {}: {}", target_id, e);
            None
        }
    }
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
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read SSH password: {}", e)),
    }
}

#[tauri::command]
pub async fn set_ssh_password(target_id: String, password: String) -> Result<(), String> {
    if target_id.trim().is_empty() {
        return Err("target_id cannot be empty".to_string());
    }
    let entry = keyring_entry(&target_id)
        .ok_or_else(|| "Credential store unavailable".to_string())?;
    entry
        .set_password(&password)
        .map_err(|e| format!("Failed to store SSH password: {}", e))?;
    info!(target = %target_id, "SSH password stored");
    Ok(())
}

#[tauri::command]
pub async fn delete_ssh_password(target_id: String) -> Result<(), String> {
    let entry = match keyring_entry(&target_id) {
        Some(e) => e,
        None => return Ok(()),
    };
    match entry.delete_credential() {
        Ok(()) => {
            info!(target = %target_id, "SSH password deleted");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete SSH password: {}", e)),
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
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Ok(false),
    }
}
