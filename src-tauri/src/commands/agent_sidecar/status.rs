//! Lifecycle status types, lifetime stats, and persistence helpers.
//!
//! The frontend status-bar chip polls `get_sidecar_status` on mount and then
//! subscribes to `sidecar-status:changed` for reactive updates.

use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::core::brand::DATA_DIR_NAME;
use crate::core::shared::home_dir;

/// Persistent lifetime counters for the sidecar (v2 Tier 4 slice A).
///
/// Survives app restarts via `~/.packetade/sidecar-stats.json`. Tracks
/// cumulative health signals that the per-run `SidecarStatusInner` cannot,
/// because the latter resets every time the process starts.
///
/// All updates are persisted through [`save_lifetime_stats`], which writes
/// atomically via a `.tmp` sibling + rename. Read-side is tolerant of missing
/// or corrupt files — either condition yields the `Default` value.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SidecarLifetimeStats {
    /// Number of successful `ready` handshakes observed across all app runs.
    #[serde(default)]
    pub total_starts: u64,
    /// Number of unexpected child exits / spawn failures observed across all
    /// app runs. Each transition into a crash path increments this once.
    #[serde(default)]
    pub total_crashes: u64,
    /// RFC3339 timestamp of the most recent crash, if any.
    #[serde(default)]
    pub last_crash_time: Option<String>,
    /// Version string from the most recent successful `ready` event — useful
    /// for spotting regressions after a sidecar upgrade.
    #[serde(default)]
    pub last_version: Option<String>,
    /// Last-seen error message. Persisted (unlike the in-memory
    /// `SidecarStatusInner::last_error`) so hover-tooltips survive restarts.
    #[serde(default)]
    pub last_error: Option<String>,
    /// Cumulative seconds spent in the `Ready` state across all app runs.
    /// Advanced on each child exit by `now - session_start_instant`.
    #[serde(default)]
    pub total_uptime_secs: u64,
}

/// Snapshot of the sidecar's current lifecycle state. Serialized to JSON and
/// returned from the `get_sidecar_status` command; the same payload is used
/// for the `sidecar-status:changed` event so the frontend can treat both the
/// initial poll and the push updates identically.
///
/// Field names are intentionally snake_case in the wire format to match the
/// TypeScript `SidecarStatus` shape exported from `src/lib/tauri.ts`.
#[derive(Clone, Serialize)]
pub struct SidecarStatus {
    /// One of "ready", "restarting", "down", "not_started".
    pub state: String,
    /// Lifetime restart count (does not reset when the rate-limit window
    /// expires — this is the cumulative count the chip shows as `(N/3)`).
    pub restart_count: u32,
    /// Last crash/spawn-error message, if any.
    pub last_error: Option<String>,
    /// Current child PID if the sidecar is ready.
    pub pid: Option<u32>,
    /// Version string reported by the most recent `ready` event.
    pub version: Option<String>,
    /// Cross-restart counters persisted to `~/.packetade/sidecar-stats.json`.
    /// Populated on every `get_sidecar_status` poll and every
    /// `sidecar-status:changed` event emission.
    pub lifetime: SidecarLifetimeStats,
}

/// Interior mutable state backing `SidecarManager::status`. Wrapped in one
/// `Mutex` rather than split across many so that updates + emit happen
/// atomically relative to each other.
#[derive(Default)]
pub(super) struct SidecarStatusInner {
    pub state: SidecarState,
    pub restart_count: u32,
    pub last_error: Option<String>,
    pub pid: Option<u32>,
    pub version: Option<String>,
    /// Cross-restart counters. Loaded from disk on `SidecarManager::new` and
    /// flushed after every mutation. Kept in the same mutex as the live
    /// fields so a snapshot observed by the frontend is always internally
    /// consistent.
    pub lifetime: SidecarLifetimeStats,
    /// Monotonic timestamp marking when the current child transitioned into
    /// `Ready`. `None` while not ready. Used to accumulate
    /// `lifetime.total_uptime_secs` on child exit / crash.
    pub session_start: Option<Instant>,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(super) enum SidecarState {
    #[default]
    NotStarted,
    Ready,
    Restarting,
    Down,
}

impl SidecarState {
    fn as_str(self) -> &'static str {
        match self {
            SidecarState::NotStarted => "not_started",
            SidecarState::Ready => "ready",
            SidecarState::Restarting => "restarting",
            SidecarState::Down => "down",
        }
    }
}

impl SidecarStatusInner {
    pub(super) fn snapshot(&self) -> SidecarStatus {
        SidecarStatus {
            state: self.state.as_str().to_string(),
            restart_count: self.restart_count,
            last_error: self.last_error.clone(),
            pid: self.pid,
            version: self.version.clone(),
            lifetime: self.lifetime.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Lifetime stats persistence (v2 Tier 4 slice A)
//
// Stored at `$HOME/.packetade/sidecar-stats.json`. The schema is whatever
// `SidecarLifetimeStats` currently serializes to — all fields use
// `#[serde(default)]` so older/newer files load cleanly across schema
// changes.
//
// Writes are atomic: serialize → write to `sidecar-stats.json.tmp` →
// `rename()` over the real file. A power-loss between those two steps
// leaves the previous version intact; worst case the `.tmp` sibling
// lingers and is overwritten on the next save.
// ---------------------------------------------------------------------------

/// Filename (inside `DATA_DIR_NAME`) holding the persisted counters.
const SIDECAR_STATS_FILENAME: &str = "sidecar-stats.json";

/// Absolute path to the persisted stats file under `~/.packetade/`.
fn lifetime_stats_path() -> PathBuf {
    let home = home_dir().unwrap_or_else(|| ".".to_string());
    PathBuf::from(home)
        .join(DATA_DIR_NAME)
        .join(SIDECAR_STATS_FILENAME)
}

/// Read lifetime counters from disk. Returns the `Default` value if the file
/// is missing or fails to parse — this path must never prevent startup.
pub(super) fn load_lifetime_stats() -> SidecarLifetimeStats {
    let path = lifetime_stats_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // First run on this machine — zeros are the correct baseline.
            return SidecarLifetimeStats::default();
        }
        Err(e) => {
            warn!(
                error = %e,
                path = %path.display(),
                "unable to read sidecar lifetime stats; using defaults"
            );
            return SidecarLifetimeStats::default();
        }
    };
    match serde_json::from_str::<SidecarLifetimeStats>(&content) {
        Ok(stats) => stats,
        Err(e) => {
            warn!(
                error = %e,
                path = %path.display(),
                "sidecar lifetime stats file is corrupt; resetting"
            );
            SidecarLifetimeStats::default()
        }
    }
}

/// Persist lifetime counters atomically. Creates `~/.packetade/` on demand.
pub(super) fn save_lifetime_stats(stats: &SidecarLifetimeStats) -> Result<(), String> {
    let path = lifetime_stats_path();
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {:?}: {}", parent, e))?;
        }
    }
    let json = serde_json::to_string_pretty(stats)
        .map_err(|e| format!("serialize sidecar lifetime stats: {}", e))?;
    write_atomic(&path, json.as_bytes()).map_err(|e| format!("write {:?}: {}", path, e))?;
    Ok(())
}

/// Write `bytes` to `path` atomically via a `.tmp` sibling + rename.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(match path.extension() {
        Some(ext) => format!("{}.tmp", ext.to_string_lossy()),
        None => "tmp".to_string(),
    });
    std::fs::write(&tmp, bytes)?;
    // `rename` is atomic on the same filesystem on Windows (MoveFileEx with
    // MOVEFILE_REPLACE_EXISTING semantics via std) and on Unix. Both are
    // what we need for "either old or new, never torn".
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Format the current wall-clock time as an RFC3339 UTC string
/// (`YYYY-MM-DDTHH:MM:SSZ`). Used for `last_crash_time`. Written by hand so
/// we don't need to add a `chrono` / `time` dependency for a single field.
pub(super) fn current_time_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_rfc3339_utc(secs)
}

/// Convert Unix seconds (UTC) to an RFC3339 string. Implements the civil
/// calendar conversion directly rather than pulling in a time crate.
///
/// Algorithm: Howard Hinnant's days-from-civil inverse — splits the epoch
/// into whole days + time-of-day, then walks 400/100/4-year cycles to find
/// the calendar date. Handles negative inputs for completeness but in
/// practice `secs` comes from `SystemTime::now()` so it's always >= 0.
fn format_rfc3339_utc(mut secs: i64) -> String {
    let mut days = secs.div_euclid(86_400);
    secs = secs.rem_euclid(86_400);
    let hour = (secs / 3600) as u32;
    let minute = ((secs % 3600) / 60) as u32;
    let second = (secs % 60) as u32;

    // Shift epoch so 0 == 0000-03-01 (the anchor Hinnant's algorithm uses).
    days += 719_468;
    let era = if days >= 0 {
        days / 146_097
    } else {
        (days - 146_096) / 146_097
    };
    let doe = (days - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hour, minute, second
    )
}
