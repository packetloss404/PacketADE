//! One-shot startup migrations for the PacketCode → PacketBench rename.
//!
//! Runs once per launch early in `lib::run`. Best-effort — logs warnings on
//! failure but never blocks app startup.

use crate::core::brand::{DATA_DIR_NAME, LEGACY_DATA_DIR_NAME};
use std::path::Path;
use tracing::{info, warn};

/// Entries only ever created in the data dir by THIS app (the PacketBench IDE).
/// Presence of any one of them is positive evidence that a `~/.packetcode` is
/// our own pre-rename directory and is safe to migrate.
///
/// Deliberately excludes `sessions/`, `backups/` and `commands/`: the sibling
/// `packetcode` TUI creates directories with those exact names too, so they
/// prove nothing about ownership.
const PACKETBENCH_MARKERS: &[&str] = &[
    crate::core::storage::STATE_FILENAME,
    "conversations",
    "missions",
    "pty-transcripts",
    "pty-active-pids",
    "dictation.db",
    "dictation.json",
    "usage.jsonl",
    "provider-launches.json",
    "sidecar-stats.json",
    "git-hosts.json",
    "github-token",
    "known_hosts",
    "models",
    "scratch",
    "crashes",
    "ssh",
    "ssh-cm",
];

/// Entries only ever created by the sibling `packetcode` TUI, which claimed
/// `~/.packetcode` as its own data home AFTER this rename shipped (see that
/// project's `internal/config/paths.go`). Any one of them means the directory
/// belongs to the TUI and must never be renamed, copied or written to.
const PACKETCODE_TUI_MARKERS: &[&str] = &[
    "config.toml",
    "theme.toml",
    "cost-tally.json",
    "computers",
    "jobs",
    "worktrees",
    "workflows",
];

/// Who owns a `~/.packetcode` directory found on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegacyDirShape {
    /// Our own pre-rename data dir — safe to migrate and safe to read from.
    Ours,
    /// The sibling `packetcode` TUI's home — hands off.
    Foreign,
    /// Carries BOTH our markers and the TUI's. Real on machines where the
    /// earlier PacketCode → PacketADE rename folded TUI files into what became
    /// our data dir. Our own data must still be rescued, but the directory as a
    /// whole must not be moved, so this is copy-only.
    Mixed,
    /// Missing, empty, or carrying only names both products use. Treated as
    /// not-ours: there is nothing of ours to lose, and guessing wrong here
    /// destroys someone else's data.
    Unknown,
}

/// Classify a legacy `~/.packetcode` directory by the files it contains.
///
/// A directory carrying both shapes is `Mixed`, not `Foreign`. The veto exists
/// to stop us DESTROYING a TUI home, and a blanket veto over-served that: it
/// also abandoned our own state living in the same directory. Observed in the
/// field — a `~/.packetade` holding `config.toml` and `cost-tally.json` folded
/// in by the earlier PacketCode → PacketADE rename, alongside a live
/// `state.v1.json` with the user's real issues and workspaces. Classifying that
/// `Foreign` silently stranded every one of them.
///
/// `Mixed` resolves the ambiguity by copying our own files out rather than
/// moving the directory, so nothing of the TUI's is moved, renamed or deleted.
pub(crate) fn classify_legacy_dir(dir: &Path) -> LegacyDirShape {
    let contains_any = |names: &[&str]| names.iter().any(|name| dir.join(name).exists());
    let theirs = contains_any(PACKETCODE_TUI_MARKERS);
    let ours = contains_any(PACKETBENCH_MARKERS);
    match (ours, theirs) {
        (true, true) => LegacyDirShape::Mixed,
        (true, false) => LegacyDirShape::Ours,
        (false, true) => LegacyDirShape::Foreign,
        (false, false) => LegacyDirShape::Unknown,
    }
}

/// Migrate the user data directory from the legacy home (`~/.packetade`, the
/// immediately-prior product name) → `~/.packetbench/`.
///
/// - If the new dir already exists, do nothing (user already migrated or fresh install).
/// - If only the old dir exists, and it is recognizably OURS, rename it in
///   place (atomic on the same volume). The `Foreign` veto below is retained
///   defensively from the earlier PacketCode → PacketADE migration; the sibling
///   `packetcode` TUI only ever claimed `~/.packetcode`, never `~/.packetade`,
///   so in practice a legacy `~/.packetade` here is always ours.
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
    migrate_data_dir_in(Path::new(&home));
}

/// Body of [`migrate_data_dir`], parameterized on the home directory so tests
/// can drive it against a temp dir instead of the process-wide `HOME`.
fn migrate_data_dir_in(home: &Path) {
    let new_dir = home.join(DATA_DIR_NAME);
    let old_dir = home.join(LEGACY_DATA_DIR_NAME);

    if new_dir.exists() {
        return;
    }
    if !old_dir.exists() {
        return;
    }

    match classify_legacy_dir(&old_dir) {
        LegacyDirShape::Ours => {}
        LegacyDirShape::Mixed => {
            // Our data and the TUI's share this directory. Copy ours out and
            // leave everything else exactly where it is.
            rescue_our_files(&old_dir, &new_dir);
            return;
        }
        LegacyDirShape::Foreign => {
            warn!(
                "Skipping data-dir migration: {:?} belongs to the packetcode TUI, not to a pre-rename {}. Leaving it untouched.",
                old_dir,
                crate::core::brand::APP_NAME
            );
            return;
        }
        LegacyDirShape::Unknown => {
            info!(
                "Skipping data-dir migration: {:?} carries no evidence of pre-rename {} data.",
                old_dir,
                crate::core::brand::APP_NAME
            );
            return;
        }
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

/// Copy only the entries we know are ours out of a [`LegacyDirShape::Mixed`]
/// directory, leaving the legacy directory — and anything in it we do not
/// recognise — untouched.
///
/// Best-effort per entry: one unreadable file must not cost the user the rest
/// of their state. Nothing is deleted or renamed on either side.
fn rescue_our_files(old_dir: &Path, new_dir: &Path) {
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        warn!("Cannot create {:?} to rescue legacy data: {}", new_dir, e);
        return;
    }

    let mut copied = 0usize;
    let mut failed = 0usize;
    for marker in PACKETBENCH_MARKERS {
        let src = old_dir.join(marker);
        if !src.exists() {
            continue;
        }
        let dst = new_dir.join(marker);
        if dst.exists() {
            // Never overwrite state the new dir already has: that is the
            // user's current data, and merging two live states is not
            // something this migration can decide.
            continue;
        }
        let result = if src.is_dir() {
            copy_dir_all(&src, &dst)
        } else {
            std::fs::copy(&src, &dst).map(|_| ())
        };
        match result {
            Ok(()) => copied += 1,
            Err(e) => {
                failed += 1;
                warn!("Could not rescue {:?} from the legacy data dir: {}", src, e);
            }
        }
    }

    info!(
        "Legacy dir {:?} holds both our data and the packetcode TUI's. Copied {} of our entries into {:?} ({} failed); the legacy dir was left untouched.",
        old_dir, copied, new_dir, failed
    );
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
            "packetbench-mission-mig-{}-{:?}",
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
            "packetbench-mission-mig-noop-{}-{:?}",
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

    /// Create a fresh, unique temp dir standing in for the user's home.
    /// Mirrors the `std::env::temp_dir()` + nanosecond-suffix convention used
    /// elsewhere in this crate (no extra dev-dependency required).
    fn unique_temp_home(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("packetbench-datadir-mig-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("create temp home");
        dir
    }

    /// Lay out a `~/.packetcode` shaped like the sibling `packetcode` TUI's
    /// home: its own config plus the dirs only it creates, and the two dir
    /// names (`sessions/`, `backups/`) that both products happen to use.
    fn make_tui_home(home: &std::path::Path) -> std::path::PathBuf {
        let dir = home.join(LEGACY_DATA_DIR_NAME);
        for sub in ["sessions", "jobs", "worktrees", "computers", "backups"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        std::fs::write(dir.join("config.toml"), "model = \"opus\"\n").unwrap();
        std::fs::write(dir.join("cost-tally.json"), "{\"total\":1}").unwrap();
        std::fs::write(dir.join("sessions/s1.json"), "{\"id\":\"s1\"}").unwrap();
        dir
    }

    /// Lay out a `~/.packetcode` shaped like a pre-rename PacketBench data dir.
    fn make_legacy_packetbench_home(home: &std::path::Path) -> std::path::PathBuf {
        let dir = home.join(LEGACY_DATA_DIR_NAME);
        std::fs::create_dir_all(dir.join("conversations")).unwrap();
        std::fs::create_dir_all(dir.join("missions")).unwrap();
        std::fs::write(
            dir.join(crate::core::storage::STATE_FILENAME),
            "{\"version\":7}",
        )
        .unwrap();
        std::fs::write(dir.join("conversations/c1.json"), "{\"id\":\"c1\"}").unwrap();
        dir
    }

    #[test]
    fn migrate_data_dir_leaves_packetcode_tui_home_alone() {
        // The regression this guards: on a fresh machine the TUI is installed
        // first, so `~/.packetcode` exists and `~/.packetbench` does not — the
        // exact shape the old code read as "legacy dir, rename it".
        let home = unique_temp_home("tui");
        let legacy = make_tui_home(&home);

        migrate_data_dir_in(&home);

        assert!(
            legacy.join("config.toml").exists(),
            "TUI config.toml must survive"
        );
        assert!(
            legacy.join("sessions/s1.json").exists(),
            "TUI sessions must survive"
        );
        assert!(
            legacy.join("jobs").is_dir() && legacy.join("computers").is_dir(),
            "TUI dirs must survive"
        );
        assert!(
            !home.join(DATA_DIR_NAME).exists(),
            "no PacketBench dir should be conjured out of the TUI's home"
        );

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn migrate_data_dir_migrates_legacy_packetbench_home() {
        let home = unique_temp_home("ours");
        let legacy = make_legacy_packetbench_home(&home);

        migrate_data_dir_in(&home);

        let new_dir = home.join(DATA_DIR_NAME);
        assert!(!legacy.exists(), "legacy dir should have been renamed away");
        assert_eq!(
            std::fs::read_to_string(new_dir.join(crate::core::storage::STATE_FILENAME)).unwrap(),
            "{\"version\":7}"
        );
        assert_eq!(
            std::fs::read_to_string(new_dir.join("conversations/c1.json")).unwrap(),
            "{\"id\":\"c1\"}"
        );
        assert!(new_dir.join("missions").is_dir());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn migrate_data_dir_is_noop_when_both_dirs_exist() {
        let home = unique_temp_home("both");
        let legacy = make_legacy_packetbench_home(&home);
        let new_dir = home.join(DATA_DIR_NAME);
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(
            new_dir.join(crate::core::storage::STATE_FILENAME),
            "{\"version\":9}",
        )
        .unwrap();

        migrate_data_dir_in(&home);

        assert_eq!(
            std::fs::read_to_string(new_dir.join(crate::core::storage::STATE_FILENAME)).unwrap(),
            "{\"version\":9}",
            "the live dir must not be overwritten by the legacy one"
        );
        assert!(legacy.exists(), "legacy dir is left in place, untouched");
        assert_eq!(
            std::fs::read_to_string(legacy.join(crate::core::storage::STATE_FILENAME)).unwrap(),
            "{\"version\":7}"
        );

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn migrate_data_dir_skips_unrecognizable_legacy_dir() {
        // The TUI creates its home eagerly, so an empty (or shared-names-only)
        // `~/.packetcode` is more likely to be its fresh install than ours.
        let home = unique_temp_home("unknown");
        let legacy = home.join(LEGACY_DATA_DIR_NAME);
        std::fs::create_dir_all(legacy.join("commands")).unwrap();

        migrate_data_dir_in(&home);

        assert!(legacy.join("commands").is_dir(), "left alone");
        assert!(!home.join(DATA_DIR_NAME).exists());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn classify_legacy_dir_reports_a_shared_dir_as_mixed() {
        // A dir carrying both shapes is Mixed, not Foreign. This was observed in
        // the field: the PacketCode -> PacketADE rename folded `config.toml` and
        // `cost-tally.json` in beside a live `state.v1.json`, and reading the
        // whole directory as Foreign stranded the user's real issues and
        // workspaces.
        let home = unique_temp_home("mixed");
        let legacy = make_legacy_packetbench_home(&home);
        std::fs::write(legacy.join("config.toml"), "model = \"opus\"\n").unwrap();
        std::fs::write(legacy.join("cost-tally.json"), "{\"sessions\":[]}").unwrap();

        assert_eq!(classify_legacy_dir(&legacy), LegacyDirShape::Mixed);
        assert_eq!(
            classify_legacy_dir(&home.join("does-not-exist")),
            LegacyDirShape::Unknown
        );

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_dir_with_only_tui_markers_is_still_foreign() {
        let home = unique_temp_home("foreign-only");
        let legacy = home.join(LEGACY_DATA_DIR_NAME);
        std::fs::create_dir_all(legacy.join("jobs")).unwrap();
        std::fs::write(legacy.join("config.toml"), "model = \"opus\"\n").unwrap();

        assert_eq!(classify_legacy_dir(&legacy), LegacyDirShape::Foreign);

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn a_mixed_dir_is_rescued_by_copy_and_never_moved() {
        let home = unique_temp_home("mixed-migrate");
        let legacy = make_legacy_packetbench_home(&home);
        std::fs::write(legacy.join("config.toml"), "model = \"opus\"\n").unwrap();

        migrate_data_dir_in(&home);

        let new_dir = home.join(DATA_DIR_NAME);
        // Our data was rescued...
        assert_eq!(
            std::fs::read_to_string(new_dir.join(crate::core::storage::STATE_FILENAME)).unwrap(),
            "{\"version\":7}"
        );
        assert_eq!(
            std::fs::read_to_string(new_dir.join("conversations/c1.json")).unwrap(),
            "{\"id\":\"c1\"}"
        );
        // ...the TUI's file was not taken along...
        assert!(!new_dir.join("config.toml").exists());
        // ...and nothing on the legacy side was moved or deleted.
        assert!(legacy.join(crate::core::storage::STATE_FILENAME).exists());
        assert!(legacy.join("config.toml").exists());

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn rescue_never_overwrites_state_the_new_dir_already_has() {
        let home = unique_temp_home("mixed-nooverwrite");
        let legacy = make_legacy_packetbench_home(&home);
        std::fs::write(legacy.join("config.toml"), "model = \"opus\"\n").unwrap();
        let new_dir = home.join(DATA_DIR_NAME);
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(
            new_dir.join(crate::core::storage::STATE_FILENAME),
            "{\"version\":50}",
        )
        .unwrap();

        rescue_our_files(&legacy, &new_dir);

        // Merging two live states is not this migration's call to make.
        assert_eq!(
            std::fs::read_to_string(new_dir.join(crate::core::storage::STATE_FILENAME)).unwrap(),
            "{\"version\":50}"
        );
        // Entries the new dir lacks are still rescued.
        assert!(new_dir.join("conversations/c1.json").exists());

        std::fs::remove_dir_all(&home).ok();
    }
}
