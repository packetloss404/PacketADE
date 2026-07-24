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

fn migrate_legacy_ssh_password(
    target_id: &str,
    password: String,
    write_new: impl FnOnce(&str) -> keyring::Result<()>,
    delete_legacy: impl FnOnce() -> keyring::Result<()>,
) -> Result<String, String> {
    if let Err(e) = write_new(&password) {
        warn!(
            target = %target_id,
            error = %e,
            "Failed to migrate SSH password from legacy keyring service; keeping legacy credential"
        );
        return Ok(password);
    }

    match delete_legacy() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            info!(target = %target_id, "Migrated SSH password from legacy keyring service");
        }
        Err(e) => {
            warn!(
                target = %target_id,
                error = %e,
                "Failed to delete legacy SSH password after migration"
            );
        }
    }

    Ok(password)
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
                    return migrate_legacy_ssh_password(
                        target_id,
                        pw,
                        |pw| entry.set_password(pw),
                        || legacy.delete_credential(),
                    )
                    .map(Some);
                }
            }
            Ok(None)
        }
        Err(e) => Err(format!("Failed to read SSH password: {}", e)),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn legacy_ssh_password_migration_deletes_only_after_new_write_succeeds() {
        let write_completed = Cell::new(false);
        let delete_observed_write = Cell::new(false);

        let result = migrate_legacy_ssh_password(
            "prod",
            "secret".to_string(),
            |password| {
                assert_eq!(password, "secret");
                write_completed.set(true);
                Ok(())
            },
            || {
                delete_observed_write.set(write_completed.get());
                Ok(())
            },
        );

        assert_eq!(result.as_deref(), Ok("secret"));
        assert!(delete_observed_write.get());
    }

    #[test]
    fn legacy_ssh_password_migration_returns_legacy_when_new_write_fails() {
        let delete_called = Cell::new(false);

        let result = migrate_legacy_ssh_password(
            "prod",
            "secret".to_string(),
            |_| Err(keyring::Error::Invalid("password".into(), "denied".into())),
            || {
                delete_called.set(true);
                Ok(())
            },
        );

        assert_eq!(result.as_deref(), Ok("secret"));
        assert!(!delete_called.get());
    }
}
