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
/// - A same-volume rename is tried first; on failure (e.g. a cross-volume home
///   where Windows returns ERROR_NOT_SAME_DEVICE) we fall back to a recursive
///   copy and treat the migration as successful only if the copy FULLY
///   succeeds, leaving the legacy dir intact as a backup.
/// - On any failure, log a warning and leave both dirs alone; `data_dir()`
///   falls back to the legacy path so readers and writers stay consistent.
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
        Ok(()) => {
            info!("Migrated data dir: {:?} → {:?}", old_dir, new_dir);
            return;
        }
        Err(e) => warn!(
            "Rename migration {:?} → {:?} failed: {}. Falling back to recursive copy.",
            old_dir, new_dir, e
        ),
    }

    // Cross-volume fallback: copy the tree, leaving the legacy dir intact as a
    // backup. Only treat as migrated if the copy fully succeeds.
    match copy_dir_all(&old_dir, &new_dir) {
        Ok(()) => info!(
            "Migrated data dir via copy: {:?} → {:?}. Legacy dir kept as backup.",
            old_dir, new_dir
        ),
        Err(e) => {
            // Remove a partial copy so data_dir() doesn't see an incomplete new
            // dir and skip the still-good legacy dir.
            let _ = std::fs::remove_dir_all(&new_dir);
            warn!(
                "Failed to copy-migrate data dir {:?} → {:?}: {}. Legacy dir remains in place; app will read from it.",
                old_dir, new_dir, e
            );
        }
    }
}

/// Recursively copy `src` into `dst`, creating `dst` and intermediate
/// directories as needed. Best-effort helper for the cross-volume migration
/// fallback; returns the first I/O error encountered.
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
