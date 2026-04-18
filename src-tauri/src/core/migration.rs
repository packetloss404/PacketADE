//! One-shot startup migrations for the PacketCode → PacketADE rename.
//!
//! Runs once per launch early in `lib::run`. Best-effort — logs warnings on
//! failure but never blocks app startup.

use crate::core::brand::{DATA_DIR_NAME, LEGACY_DATA_DIR_NAME};
use tracing::{info, warn};

/// Migrate the user data directory from `~/.packetcode/` → `~/.packetade/`.
///
/// - If the new dir already exists, do nothing (user already migrated or fresh install).
/// - If only the old dir exists, rename it in place (atomic on the same volume).
/// - If neither exists, do nothing — the new dir will be created on first use.
/// - On failure (e.g. open file handles), log a warning and leave both dirs alone;
///   readers throughout the codebase fall back to the legacy path anyway.
pub fn migrate_data_dir() {
    let home = match crate::core::shared::home_dir() {
        Some(h) => h,
        None => return,
    };
    let home_path = std::path::PathBuf::from(home);
    let new_dir = home_path.join(DATA_DIR_NAME);
    let old_dir = home_path.join(LEGACY_DATA_DIR_NAME);

    if new_dir.exists() {
        return;
    }
    if !old_dir.exists() {
        return;
    }

    match std::fs::rename(&old_dir, &new_dir) {
        Ok(()) => info!(
            "Migrated data dir: {:?} → {:?}",
            old_dir, new_dir
        ),
        Err(e) => warn!(
            "Failed to migrate data dir {:?} → {:?}: {}. Legacy dir remains in place; app will read from it.",
            old_dir, new_dir, e
        ),
    }
}
