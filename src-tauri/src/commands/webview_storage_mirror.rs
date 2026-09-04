//! Durable mirror of the webview's `localStorage`, kept in the app data dir.
//!
//! # Why this exists
//!
//! Tauri scopes the WebView2 / WKWebView profile — and therefore the webview's
//! `localStorage` — to a directory derived from the **bundle identifier**. On
//! Windows that is literally
//! `%LOCALAPPDATA%\<identifier>\EBWebView\Default\Local Storage\leveldb`.
//! Verified on the maintainer's machine: `com.packetade.desktop` and
//! `com.packetbench.desktop` are two sibling directories, each with its own
//! `EBWebView\Default\Local Storage`.
//!
//! The 2026-08-26 rename moved the identifier from `com.packetade.desktop` to
//! `com.packetbench.desktop`, so the renamed build booted against a brand new,
//! empty `localStorage` and every `packetbench:*` key appeared to vanish. The
//! existing prefix migration (`src/lib/storage-migration.ts`) cannot help,
//! because it runs *inside* the new empty store and has nothing to read.
//!
//! The app data dir (`~/.packetbench`, `DATA_DIR_NAME` in `core::brand`) lives
//! in the user's home and is **not** keyed by the bundle identifier, so a copy
//! kept here survives any identifier change. This module is that copy.
//!
//! # Contract
//!
//! - The mirror is a **derived artifact**. `localStorage` is always the live
//!   copy; this file exists only to refill it when it comes up empty. Losing
//!   the mirror is therefore not data loss, which is why the write path uses a
//!   plain atomic replace and skips the `.bak` sidecar that
//!   `core::storage::write_with_backup` keeps for the authoritative state file.
//! - The frontend sends a **whole snapshot** of the `packetbench:*` keyspace on
//!   every save, so deletions propagate naturally and the file cannot
//!   accumulate keys the app no longer uses.
//! - A corrupt mirror is not an error: it is moved aside to `*.corrupt` and an
//!   empty map is returned, so the next save rebuilds it from the live store.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tracing::warn;

use crate::core::storage;

/// File name under the app data dir. Deliberately distinct from `state.json`:
/// stuffing an opaque `localStorage` blob into the typed `PersistedState`
/// would bloat every unrelated slice save with data no Rust code reads.
const MIRROR_FILENAME: &str = "webview-storage-mirror.json";

/// Hard ceiling on the serialized mirror. The frontend applies its own,
/// smaller budget; this is defense in depth so a runaway store can never make
/// the app write unbounded amounts of data on a debounce tick.
const MAX_MIRROR_BYTES: usize = 8 * 1024 * 1024;

/// Serializes concurrent saves. Two windows share one origin (a Monitor window
/// is the same webview origin as the main window), so two flushes can race.
static MIRROR_LOCK: Mutex<()> = Mutex::new(());

fn mirror_path() -> PathBuf {
    storage::data_dir().join(MIRROR_FILENAME)
}

/// Recover from a poisoned lock instead of failing forever. The guarded value
/// is `()` and the write is an atomic replace, so a panic while held cannot
/// have left a half-written file. Mirrors the rationale on
/// `core::storage::lock_state_mutex`.
fn lock_mirror() -> std::sync::MutexGuard<'static, ()> {
    MIRROR_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Read the durable mirror.
///
/// Returns an empty map — never an error — when the file is absent, unreadable
/// or corrupt, because "no mirror" and "unusable mirror" both mean the same
/// thing to the caller: there is nothing to restore. A corrupt file is moved
/// aside rather than deleted so it can still be inspected after the fact.
#[tauri::command]
pub fn load_webview_storage_mirror() -> Result<BTreeMap<String, String>, String> {
    Ok(read_mirror_from(&mirror_path()))
}

fn read_mirror_from(path: &PathBuf) -> BTreeMap<String, String> {
    let _lock = lock_mirror();

    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(e) => {
            warn!("Failed to read webview storage mirror {:?}: {}", path, e);
            return BTreeMap::new();
        }
    };

    match serde_json::from_str::<BTreeMap<String, String>>(&raw) {
        Ok(entries) => entries,
        Err(e) => {
            warn!(
                "Corrupt webview storage mirror {:?} ({}); setting it aside",
                path, e
            );
            let quarantine = path.with_extension("json.corrupt");
            if let Err(rename_err) = fs::rename(path, &quarantine) {
                warn!(
                    "Failed to quarantine corrupt mirror {:?}: {}",
                    path, rename_err
                );
            }
            BTreeMap::new()
        }
    }
}

/// Replace the durable mirror with `entries`.
///
/// `async` on purpose: Tauri runs non-async command handlers on the main
/// thread, and this one is on a debounced write path that can fire while the
/// user is typing.
#[tauri::command]
pub async fn save_webview_storage_mirror(
    entries: BTreeMap<String, String>,
) -> Result<(), String> {
    write_mirror_to(&mirror_path(), &entries)
}

fn write_mirror_to(path: &PathBuf, entries: &BTreeMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(entries)
        .map_err(|e| format!("Failed to serialize webview storage mirror: {}", e))?;

    if json.len() > MAX_MIRROR_BYTES {
        return Err(format!(
            "Webview storage mirror is {} bytes, over the {} byte limit; refusing to write",
            json.len(),
            MAX_MIRROR_BYTES
        ));
    }

    let _lock = lock_mirror();

    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {:?}: {}", parent, e))?;
        }
    }

    // Atomic replace: write a sibling temp file, fsync it, then rename over the
    // destination. `fs::rename` replaces an existing destination on every
    // platform (Windows uses MOVEFILE_REPLACE_EXISTING), so the destination is
    // never absent at any point — do not pre-remove it.
    let tmp_path = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create {:?}: {}", tmp_path, e))?;
        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write {:?}: {}", tmp_path, e))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync {:?}: {}", tmp_path, e))?;
    }
    fs::rename(&tmp_path, path).map_err(|e| {
        // Leave no stray temp file behind if the replace failed.
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to replace {:?}: {}", path, e)
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{}-mirror-test-{}-{}",
            crate::core::brand::TEMP_DIR_PREFIX,
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_mirror_reads_as_empty() {
        let dir = temp_dir("missing");
        assert!(read_mirror_from(&dir.join(MIRROR_FILENAME)).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_entries() {
        let dir = temp_dir("roundtrip");
        let path = dir.join(MIRROR_FILENAME);

        let mut entries = BTreeMap::new();
        entries.insert("packetbench:issues".to_string(), "{\"issues\":[]}".to_string());
        entries.insert("packetbench:routing".to_string(), "{\"mode\":\"auto\"}".to_string());

        write_mirror_to(&path, &entries).unwrap();
        assert_eq!(read_mirror_from(&path), entries);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A later snapshot fully replaces the previous one, so a key the frontend
    /// dropped does not linger in the mirror and get resurrected on a restore.
    #[test]
    fn snapshot_replaces_rather_than_merges() {
        let dir = temp_dir("replace");
        let path = dir.join(MIRROR_FILENAME);

        let mut first = BTreeMap::new();
        first.insert("packetbench:a".to_string(), "1".to_string());
        first.insert("packetbench:b".to_string(), "2".to_string());
        write_mirror_to(&path, &first).unwrap();

        let mut second = BTreeMap::new();
        second.insert("packetbench:a".to_string(), "9".to_string());
        write_mirror_to(&path, &second).unwrap();

        let read_back = read_mirror_from(&path);
        assert_eq!(read_back.get("packetbench:a").map(String::as_str), Some("9"));
        assert!(!read_back.contains_key("packetbench:b"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_mirror_is_quarantined_and_reads_as_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join(MIRROR_FILENAME);
        fs::write(&path, "{ this is not json").unwrap();

        assert!(read_mirror_from(&path).is_empty());
        assert!(!path.exists(), "corrupt mirror should have been moved aside");
        assert!(path.with_extension("json.corrupt").exists());

        // And the next write rebuilds it cleanly.
        let mut entries = BTreeMap::new();
        entries.insert("packetbench:a".to_string(), "1".to_string());
        write_mirror_to(&path, &entries).unwrap();
        assert_eq!(read_mirror_from(&path), entries);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_mirror_is_refused_and_leaves_the_previous_file_intact() {
        let dir = temp_dir("oversized");
        let path = dir.join(MIRROR_FILENAME);

        let mut good = BTreeMap::new();
        good.insert("packetbench:a".to_string(), "1".to_string());
        write_mirror_to(&path, &good).unwrap();

        let mut huge = BTreeMap::new();
        huge.insert("packetbench:huge".to_string(), "x".repeat(MAX_MIRROR_BYTES + 1));
        let err = write_mirror_to(&path, &huge).unwrap_err();
        assert!(err.contains("over the"), "unexpected error: {err}");

        assert_eq!(read_mirror_from(&path), good);
        assert!(
            !path.with_extension("json.tmp").exists(),
            "refused write must not leave a temp file"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
