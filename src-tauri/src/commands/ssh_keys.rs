//! SSH password storage in the OS credential store, keyed by SSH target id.

use crate::core::brand::{KEYRING_SERVICE, LEGACY_KEYRING_SERVICE};
use tracing::{info, warn};

fn keyring_entry_for(service: &str, target_id: &str) -> Result<keyring::Entry, String> {
    match keyring::Entry::new(service, &format!("ssh-{}", target_id)) {
        Ok(entry) => Ok(entry),
        Err(e) => {
            warn!(
                "Failed to create keyring entry for ssh target {}: {}",
                target_id, e
            );
            Err(format!("OS credential store is unavailable: {}", e))
        }
    }
}

fn keyring_entry(target_id: &str) -> Result<keyring::Entry, String> {
    keyring_entry_for(KEYRING_SERVICE, target_id)
}

fn legacy_keyring_entry(target_id: &str) -> Result<keyring::Entry, String> {
    keyring_entry_for(LEGACY_KEYRING_SERVICE, target_id)
}

fn save_ssh_password_credential(
    target_id: &str,
    password: &str,
    write_current: impl FnOnce(&str) -> keyring::Result<()>,
    delete_legacy: impl FnOnce() -> keyring::Result<()>,
    rollback_current: impl FnOnce() -> keyring::Result<()>,
) -> Result<(), String> {
    write_current(password).map_err(|e| format!("Failed to save SSH password: {}", e))?;
    match delete_legacy() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            let rollback = rollback_current();
            return Err(match rollback {
                Ok(()) | Err(keyring::Error::NoEntry) => format!(
                    "Failed to purge the legacy SSH credential; the new password was rolled back: {}",
                    e
                ),
                Err(rollback_error) => format!(
                    "SSH credential update is incomplete: legacy purge failed ({}) and the new password could not be rolled back ({}). Retry from Settings before using this host.",
                    e, rollback_error
                ),
            });
        }
    }
    info!(target = %target_id, "SSH password saved");
    Ok(())
}

fn migrate_legacy_ssh_password(
    target_id: &str,
    password: String,
    write_new: impl FnOnce(&str) -> keyring::Result<()>,
    delete_legacy: impl FnOnce() -> keyring::Result<()>,
    rollback_new: impl FnOnce() -> keyring::Result<()>,
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
            let rollback = rollback_new();
            warn!(
                target = %target_id,
                error = %e,
                "Failed to delete legacy SSH password after migration"
            );
            if let Err(rollback_error) = rollback {
                warn!(
                    target = %target_id,
                    error = %rollback_error,
                    "Failed to roll back current SSH credential after migration failure"
                );
            }
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
    restore_originals: impl FnOnce() -> Result<(), String>,
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
        return match restore_originals() {
            Ok(()) => Err(format!(
                "Failed to delete SSH password; the original credentials were restored: {}",
                e
            )),
            Err(restore_error) => Err(format!(
                "SSH credential deletion is incomplete: delete failed ({}) and rollback failed ({}). Retry from Settings before using this host.",
                e, restore_error
            )),
        };
    }

    info!(target = %target_id, "SSH password deleted");
    Ok(())
}

/// Load an SSH password for a target. Internal only — not exposed to frontend.
/// Returns Ok(None) when no password is stored (e.g. key-based auth).
/// Used by `tool_runtime_ssh` when it runs commands on a remote host.
pub fn load_ssh_password(target_id: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(target_id)?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => {
            let legacy = legacy_keyring_entry(target_id)?;
            match legacy.get_password() {
                Ok(pw) => {
                    return migrate_legacy_ssh_password(
                        target_id,
                        pw,
                        |pw| entry.set_password(pw),
                        || legacy.delete_credential(),
                        || entry.delete_credential(),
                    )
                    .map(Some);
                }
                Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("Failed to read legacy SSH password: {}", e)),
            }
            Ok(None)
        }
        Err(e) => Err(format!("Failed to read SSH password: {}", e)),
    }
}

#[tauri::command]
pub async fn get_ssh_password_exists(target_id: String) -> Result<bool, String> {
    let entry = keyring_entry(&target_id)?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => {
            let legacy = legacy_keyring_entry(&target_id)?;
            match legacy.get_password() {
                Ok(_) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(e) => Err(format!("Failed to read legacy SSH password: {}", e)),
            }
        }
        Err(e) => Err(format!("Failed to read SSH password: {}", e)),
    }
}

/// Store an SSH password in the OS credential store. The secret is accepted
/// only as an invoke argument and is never added to `ServerConfig`, frontend
/// persistence, logs, or ordinary files.
#[tauri::command]
pub async fn set_ssh_password(server_id: String, password: String) -> Result<(), String> {
    if server_id.trim().is_empty() {
        return Err("Server id cannot be empty.".to_string());
    }
    if password.is_empty() {
        return Err("SSH password cannot be empty.".to_string());
    }
    let entry = keyring_entry(&server_id)?;
    let legacy = legacy_keyring_entry(&server_id)?;
    let previous = match entry.get_password() {
        Ok(password) => Some(password),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(format!("Failed to read existing SSH password: {}", e)),
    };
    save_ssh_password_credential(
        &server_id,
        &password,
        |password| entry.set_password(password),
        || legacy.delete_credential(),
        || match previous {
            Some(previous) => entry.set_password(&previous),
            None => entry.delete_credential(),
        },
    )
}

/// Remove a stored SSH password when its server record is deleted.
///
/// The current and legacy entries are handled as one recoverable operation. If
/// either delete fails, the command attempts to restore both original values
/// and returns an error so Settings can keep/restore the server record instead
/// of falsely reporting a completed deletion.
#[tauri::command]
pub async fn delete_ssh_password(server_id: String) -> Result<(), String> {
    if server_id.trim().is_empty() {
        return Err("Server id cannot be empty.".to_string());
    }

    let entry = keyring_entry(&server_id)?;
    let legacy = legacy_keyring_entry(&server_id)?;
    let current_before = match entry.get_password() {
        Ok(password) => Some(password),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            return Err(format!(
                "Failed to read SSH password before deletion: {}",
                e
            ))
        }
    };
    let legacy_before = match legacy.get_password() {
        Ok(password) => Some(password),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            return Err(format!(
                "Failed to read legacy SSH password before deletion: {}",
                e
            ))
        }
    };

    delete_ssh_password_credentials(
        &server_id,
        || entry.delete_credential(),
        || legacy.delete_credential(),
        || {
            let restore = |entry: &keyring::Entry, value: &Option<String>| match value {
                Some(password) => entry.set_password(password),
                None => match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(error) => Err(error),
                },
            };
            restore(&entry, &current_before)
                .map_err(|e| format!("restore current credential: {}", e))?;
            restore(&legacy, &legacy_before)
                .map_err(|e| format!("restore legacy credential: {}", e))?;
            Ok(())
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
            || panic!("successful migration must not roll back"),
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
            || panic!("failed write must not roll back a value that was never written"),
        );

        assert_eq!(result.as_deref(), Ok("secret"));
        assert!(!delete_called.get());
    }

    #[test]
    fn save_ssh_password_writes_current_and_purges_legacy() {
        let wrote_secret = Cell::new(false);
        let purged_legacy = Cell::new(false);
        let result = save_ssh_password_credential(
            "srv-1",
            "secret",
            |password| {
                assert_eq!(password, "secret");
                wrote_secret.set(true);
                Ok(())
            },
            || {
                purged_legacy.set(true);
                Ok(())
            },
            || panic!("successful save must not roll back"),
        );
        assert_eq!(result, Ok(()));
        assert!(wrote_secret.get());
        assert!(purged_legacy.get());
    }

    #[test]
    fn save_ssh_password_reports_credential_store_failure() {
        let purge_called = Cell::new(false);
        let error = save_ssh_password_credential(
            "srv-1",
            "secret",
            |_| {
                Err(keyring::Error::Invalid(
                    "credential".into(),
                    "locked".into(),
                ))
            },
            || {
                purge_called.set(true);
                Ok(())
            },
            || panic!("failed write must not invoke rollback"),
        )
        .unwrap_err();
        assert!(error.contains("Failed to save SSH password"));
        assert!(error.contains("locked"));
        assert!(!purge_called.get());
    }

    #[test]
    fn save_ssh_password_rolls_back_when_legacy_purge_fails() {
        let rollback_called = Cell::new(false);
        let error = save_ssh_password_credential(
            "srv-1",
            "new-secret",
            |_| Ok(()),
            || Err(keyring::Error::Invalid("legacy".into(), "locked".into())),
            || {
                rollback_called.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("legacy SSH credential"));
        assert!(error.contains("rolled back"));
        assert!(rollback_called.get());
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
            || panic!("successful delete must not restore"),
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
            || panic!("successful delete must not restore"),
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
            || panic!("missing credentials are a successful delete"),
        );

        assert_eq!(result, Ok(()));
    }

    #[test]
    fn delete_ssh_password_reports_a_real_store_failure() {
        let legacy_deleted = Cell::new(false);
        let restored = Cell::new(false);

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
            || {
                restored.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("Failed to delete SSH password"));
        assert!(error.contains("restored"));
        assert!(error.contains("locked"));
        // A failure on the current entry must not short-circuit the legacy purge.
        assert!(legacy_deleted.get());
        assert!(restored.get());
    }
}
