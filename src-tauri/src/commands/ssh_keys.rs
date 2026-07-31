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

/// Purge both the current and legacy credential for a target.
///
/// Both are cleared unconditionally: reads auto-migrate from
/// `LEGACY_KEYRING_SERVICE`, so leaving a legacy entry behind would let the
/// password resurrect itself the next time an id is reused. A missing entry
/// (`NoEntry`) is success — deleting a key-auth or agent-auth server that
/// never stored a password must not fail.
fn delete_ssh_password_credentials(
    target_id: &str,
    delete_current: impl FnOnce() -> keyring::Result<()>,
    delete_legacy: impl FnOnce() -> keyring::Result<()>,
) -> Result<(), String> {
    let mut first_error: Option<keyring::Error> = None;

    for result in [delete_current(), delete_legacy()] {
        match result {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) if first_error.is_none() => {
                first_error = Some(e);
            }
            Err(_) => {}
        }
    }

    if let Some(e) = first_error {
        return Err(format!("Failed to delete SSH password: {}", e));
    }

    info!(target = %target_id, "SSH password deleted");
    Ok(())
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

/// Remove a stored SSH password when its server record is deleted.
///
/// Without this the secret outlived the `ServerConfig` forever with no path in
/// the app to remove it. Callers treat this as best-effort — a credential-store
/// failure must not block the server delete.
#[tauri::command]
pub async fn delete_ssh_password(server_id: String) -> Result<(), String> {
    if server_id.trim().is_empty() {
        return Err("Server id cannot be empty.".to_string());
    }

    let entry = keyring_entry(&server_id);
    let legacy = legacy_keyring_entry(&server_id);

    delete_ssh_password_credentials(
        &server_id,
        || match entry {
            Some(entry) => entry.delete_credential(),
            None => Ok(()),
        },
        || match legacy {
            Some(legacy) => legacy.delete_credential(),
            None => Ok(()),
        },
    )
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

    // The delete path is exercised through `delete_ssh_password_credentials`
    // rather than the `#[tauri::command]` wrapper: the command talks to the
    // real OS credential store, which is absent/locked on CI and in WSL, so a
    // test of the wrapper would be a keyring availability test. This mirrors
    // the seam the api_keys delete tests use.

    #[test]
    fn delete_ssh_password_clears_both_current_and_legacy_entries() {
        let current_deleted = Cell::new(false);
        let legacy_deleted = Cell::new(false);

        let result = delete_ssh_password_credentials(
            "srv-1",
            || {
                current_deleted.set(true);
                Ok(())
            },
            || {
                legacy_deleted.set(true);
                Ok(())
            },
        );

        assert!(result.is_ok());
        assert!(current_deleted.get());
        // Reads auto-migrate from the legacy service, so skipping this would
        // leave a resurrectable secret behind.
        assert!(legacy_deleted.get());
    }

    #[test]
    fn delete_ssh_password_clears_legacy_when_current_is_missing() {
        let legacy_deleted = Cell::new(false);

        let result = delete_ssh_password_credentials(
            "srv-1",
            || Err(keyring::Error::NoEntry),
            || {
                legacy_deleted.set(true);
                Ok(())
            },
        );

        assert!(result.is_ok());
        assert!(legacy_deleted.get());
    }

    #[test]
    fn delete_ssh_password_is_ok_when_no_credential_exists() {
        // A key-auth or agent-auth server never stored a password; deleting it
        // must not surface an error to the user.
        let result = delete_ssh_password_credentials(
            "srv-key-auth",
            || Err(keyring::Error::NoEntry),
            || Err(keyring::Error::NoEntry),
        );

        assert_eq!(result, Ok(()));
    }

    #[test]
    fn delete_ssh_password_reports_a_real_store_failure() {
        let legacy_deleted = Cell::new(false);

        let error = delete_ssh_password_credentials(
            "srv-1",
            || {
                Err(keyring::Error::Invalid(
                    "credential".into(),
                    "locked".into(),
                ))
            },
            || {
                legacy_deleted.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("Failed to delete SSH password"));
        assert!(error.contains("locked"));
        // A failure on the current entry must not short-circuit the legacy purge.
        assert!(legacy_deleted.get());
    }
}
