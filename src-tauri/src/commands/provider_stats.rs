//! Local-only per-provider launch counter.
//!
//! Records how many `start_api_agent_session` calls have been made for each
//! provider over the app's lifetime, along with the last-launch timestamp.
//! Purely local — nothing is reported externally.
//!
//! Storage: `<home>/.packetade/provider-launches.json`.
//!
//! Persistence strategy: in-memory `Mutex<ProviderLaunchStats>` plus an atomic
//! file write on every update (write to `*.tmp` then `rename`). These writes
//! happen on session launches — not in a hot loop — so a flush-per-call is
//! fine and avoids a background flush task.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::commands::shared::home_dir;
use crate::commands::usage::current_timestamp_iso;
use crate::core::brand::DATA_DIR_NAME;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct ProviderLaunchStats {
    /// Provider name (e.g. `"anthropic"`) → total launches over the app's lifetime.
    pub counts: HashMap<String, u64>,
    /// Provider name → most recent launch timestamp (RFC 3339 / ISO 8601 UTC).
    pub last_launch: HashMap<String, String>,
}

/// In-memory state; persisted to disk on every mutation.
///
/// Initialized lazily by reading the on-disk file on first access. Corruption
/// or a missing file both fall back to an empty `ProviderLaunchStats`.
static STATS: OnceLock<Mutex<ProviderLaunchStats>> = OnceLock::new();

fn stats() -> &'static Mutex<ProviderLaunchStats> {
    STATS.get_or_init(|| Mutex::new(load_from_disk_or_default()))
}

/// Resolve `<home>/.packetade/provider-launches.json`.
fn stats_file_path() -> Option<PathBuf> {
    let home = home_dir()?;
    let mut p = PathBuf::from(home);
    p.push(DATA_DIR_NAME);
    p.push("provider-launches.json");
    Some(p)
}

/// Read the stats file from disk. Returns default on any failure (missing
/// file, permissions error, corrupt JSON). Corruption is logged to stderr so
/// it's visible during development but never crashes the session launch.
fn load_from_disk_or_default() -> ProviderLaunchStats {
    let path = match stats_file_path() {
        Some(p) => p,
        None => return ProviderLaunchStats::default(),
    };
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return ProviderLaunchStats::default(),
    };
    match serde_json::from_slice::<ProviderLaunchStats>(&bytes) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "provider_stats: corrupt stats file at {} — starting from empty ({})",
                path.display(),
                e
            );
            ProviderLaunchStats::default()
        }
    }
}

/// Atomically persist the given stats snapshot to disk.
///
/// Writes to `<path>.tmp`, fsyncs, then renames over the final path. Any I/O
/// failure is returned as `Err(String)` — callers decide whether to surface
/// or swallow it.
fn save_to_disk(stats: &ProviderLaunchStats) -> Result<(), String> {
    let path =
        stats_file_path().ok_or_else(|| "Could not resolve home directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create data directory {}: {}", parent.display(), e))?;
    }

    let json = serde_json::to_vec_pretty(stats)
        .map_err(|e| format!("Failed to serialize provider stats: {}", e))?;

    let tmp_path = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create {}: {}", tmp_path.display(), e))?;
        f.write_all(&json)
            .map_err(|e| format!("Failed to write {}: {}", tmp_path.display(), e))?;
        f.flush()
            .map_err(|e| format!("Failed to flush {}: {}", tmp_path.display(), e))?;
        f.sync_all()
            .map_err(|e| format!("Failed to sync {}: {}", tmp_path.display(), e))?;
    }

    // On Windows, `rename` over an existing file fails; remove first. On Unix
    // `rename` is already atomic-replace, but the remove is a no-op there if
    // the path doesn't exist.
    #[cfg(windows)]
    {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }

    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to replace {}: {}", path.display(), e))?;

    Ok(())
}

/// Record a launch for the given provider: bumps the count, updates the
/// timestamp, and persists. Intended to be called from
/// `start_api_agent_session` early (after argument validation, before any
/// routing decision) so every launch is counted regardless of which backend
/// serves it.
///
/// Never panics. Disk-write failures are logged to stderr and swallowed —
/// counting is best-effort; losing a count must never break a session.
pub fn record_launch(provider: &str) {
    let snapshot = {
        let mut guard = match stats().lock() {
            Ok(g) => g,
            Err(poisoned) => {
                eprintln!("provider_stats: stats mutex poisoned — recovering");
                poisoned.into_inner()
            }
        };
        let entry = guard.counts.entry(provider.to_string()).or_insert(0);
        *entry = entry.saturating_add(1);
        guard
            .last_launch
            .insert(provider.to_string(), current_timestamp_iso());
        guard.clone()
    };

    if let Err(e) = save_to_disk(&snapshot) {
        eprintln!("provider_stats: failed to persist launch for '{}': {}", provider, e);
    }
}

/// Return a snapshot of the current stats.
pub fn read_stats() -> ProviderLaunchStats {
    match stats().lock() {
        Ok(g) => g.clone(),
        Err(poisoned) => {
            eprintln!("provider_stats: stats mutex poisoned on read — recovering");
            poisoned.into_inner().clone()
        }
    }
}

/// Tauri command — thin wrapper around `read_stats`.
#[tauri::command]
pub fn get_provider_launch_stats() -> ProviderLaunchStats {
    read_stats()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_file_path_ends_correctly() {
        if let Some(p) = stats_file_path() {
            let s = p.to_string_lossy().to_string();
            assert!(s.ends_with("provider-launches.json"));
            assert!(s.contains(DATA_DIR_NAME));
        }
    }

    #[test]
    fn default_stats_is_empty() {
        let s = ProviderLaunchStats::default();
        assert!(s.counts.is_empty());
        assert!(s.last_launch.is_empty());
    }

    #[test]
    fn roundtrip_serialization() {
        let mut s = ProviderLaunchStats::default();
        s.counts.insert("anthropic".to_string(), 3);
        s.last_launch
            .insert("anthropic".to_string(), "2026-04-21T12:00:00Z".to_string());
        let json = serde_json::to_string(&s).unwrap();
        let parsed: ProviderLaunchStats = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.counts.get("anthropic"), Some(&3));
        assert_eq!(
            parsed.last_launch.get("anthropic").map(String::as_str),
            Some("2026-04-21T12:00:00Z")
        );
    }
}
