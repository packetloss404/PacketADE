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

/// One-shot: canonicalize legacy `missionId` keys in persisted flight-approval
/// records to `flightId`.
///
/// `FlightApprovalRequest`'s `#[serde(alias = "missionId")]` deserializes the
/// legacy key into `flight_id`, so a single load → save round-trip through
/// `update_state` re-serializes it canonically and drops the legacy key (along
/// with any other unknown fields). Guarded on the raw state file still
/// containing a `missionId` key, so it's a no-op after the first canonical
/// save — cheap on every subsequent launch. Best-effort: warns on failure and
/// never blocks startup. (The Mission→Flight rename kept `missionId` as a
/// read-side alias; this is the eager pass that lets the alias be retired a
/// release later.)
pub fn migrate_mission_to_flight() {
    let path = crate::core::storage::data_dir().join(crate::core::storage::STATE_FILENAME);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        // No state file yet (fresh install) — nothing to migrate.
        Err(_) => return,
    };
    if !raw.contains("\"missionId\"") {
        return;
    }
    match crate::core::storage::update_state(|_| {}) {
        Ok(()) => info!("Canonicalized legacy missionId keys to flightId in persisted state"),
        Err(e) => warn!("mission->flight state migration failed: {}", e),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_mission_to_flight_rewrites_legacy_key_on_disk() {
        let tmp = std::env::temp_dir().join(format!(
            "packetade-mission-mig-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::core::storage::redirect_data_dir_for_test(tmp.clone());
        let path = tmp.join(crate::core::storage::STATE_FILENAME);

        // Build a real, valid state carrying one flight-approval record, then
        // downgrade the canonical `flightId` key to the legacy `missionId` on
        // disk so the migration has something to rewrite.
        let mut state = crate::core::storage::PersistedState::default();
        state
            .flight_approvals
            .push(crate::core::flight::FlightApprovalRequest {
                id: "a1".to_string(),
                flight_id: "F-1".to_string(),
                question: "q?".to_string(),
                options: Vec::new(),
                awaiting_since: 0,
                resolved: false,
                resolution: None,
                resolved_at: None,
            });
        let legacy = serde_json::to_string(&state)
            .unwrap()
            .replace("\"flightId\"", "\"missionId\"");
        assert!(legacy.contains("\"missionId\":\"F-1\""));
        std::fs::write(&path, legacy).unwrap();

        migrate_mission_to_flight();

        let after = std::fs::read_to_string(&path).unwrap();
        let after_json: serde_json::Value = serde_json::from_str(&after).unwrap();
        let approval = &after_json["flight_approvals"][0];
        assert!(
            approval.get("flightId") == Some(&serde_json::Value::String("F-1".to_string())),
            "missionId should be rewritten to flightId: {after}"
        );
        assert!(
            approval.get("missionId").is_none(),
            "legacy missionId key should be gone: {after}"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn migrate_mission_to_flight_is_noop_without_legacy_key() {
        let tmp = std::env::temp_dir().join(format!(
            "packetade-mission-mig-noop-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let _guard = crate::core::storage::redirect_data_dir_for_test(tmp.clone());
        let path = tmp.join(crate::core::storage::STATE_FILENAME);

        let state = crate::core::storage::PersistedState::default();
        let canonical = serde_json::to_string(&state).unwrap();
        std::fs::write(&path, &canonical).unwrap();

        migrate_mission_to_flight();

        // Untouched: no legacy key present, so the file is not rewritten.
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after, canonical);

        std::fs::remove_dir_all(&tmp).ok();
    }
}
