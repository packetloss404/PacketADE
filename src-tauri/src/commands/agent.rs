//! Tauri command wrappers for CLI agent detection.
//!
//! Two commands are exposed:
//! - [`detect_agent`] — legacy boolean probe (kept for back-compat).
//! - [`detect_cli_catalog`] — bulk probe that also captures version + path.
//!
//! The boolean command is implemented in terms of the catalog command so
//! the two can never drift.

use serde::{Deserialize, Serialize};

use crate::core::agent;

/// One entry of a bulk detection request.
///
/// Frontend passes the catalog id (e.g. "claude-code") alongside the
/// binary name to look up on PATH (e.g. "claude"). Keeping both lets the
/// caller correlate results regardless of binary name collisions.
///
/// `manual_path` is the v0.8.7 manual-override hook: when set, detection
/// skips PATH lookup entirely and probes the supplied absolute path
/// directly. Useful for in-development CLIs (e.g. PacketCode) and bespoke
/// install locations the user has Browse-selected.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectCatalogItem {
    pub id: String,
    pub binary: String,
    #[serde(default)]
    pub manual_path: Option<String>,
}

/// Result for a single catalog entry.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectCatalogResult {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Legacy boolean detection. Skips the version probe (back-compat callers
/// only care about the boolean) so it stays as cheap as the original
/// `where`/`which` check — never blocks on a hung `--version`.
#[tauri::command]
pub fn detect_agent(command: String) -> Result<bool, String> {
    Ok(agent::detect_agent(&command))
}

/// Bulk-detect a catalog of CLIs. Each entry's probe runs concurrently
/// (PATH lookup + version probe both async, no blocking the runtime);
/// version probes have a 3-second budget, PATH probes a 2-second budget,
/// so a hung binary cannot stall the whole sweep.
#[tauri::command]
pub async fn detect_cli_catalog(
    items: Vec<DetectCatalogItem>,
) -> Result<Vec<DetectCatalogResult>, String> {
    let futures = items.into_iter().map(|item| async move {
        // Manual-override branch: user has explicitly pointed us at a binary.
        // Skip PATH resolution and probe that exact path. If the path is
        // missing or not executable, surface `installed: false` with the
        // user-supplied path retained so the UI can highlight the bad value.
        if let Some(manual) = item.manual_path.as_deref() {
            if !agent::is_executable_file(manual) {
                return DetectCatalogResult {
                    id: item.id,
                    installed: false,
                    version: None,
                    path: Some(manual.to_string()),
                };
            }
            let version = agent::probe_version_at(manual).await;
            return DetectCatalogResult {
                id: item.id,
                installed: version.is_some(),
                version,
                path: Some(manual.to_string()),
            };
        }

        match agent::resolve_path(&item.binary).await {
            Some(path) => {
                // Probe the *resolved* absolute path rather than the bare
                // binary name. On Windows, `resolve_path` returns the full
                // `.cmd` wrapper (e.g.
                // `C:\Users\…\AppData\Roaming\npm\claude.cmd`), but
                // `probe_version` would re-invoke just `claude`, which
                // `TokioCommand::new` resolves differently than the shell
                // would — yielding `None` and a card that reads
                // "installed, no version". Going through
                // `probe_version_at` ensures the same `.cmd` we resolved
                // is the one we ask `--version`. On POSIX it's a no-op
                // difference (the resolved path is fully executable).
                let version = agent::probe_version_at(&path).await;
                DetectCatalogResult {
                    id: item.id,
                    installed: true,
                    version,
                    path: Some(path),
                }
            }
            None => DetectCatalogResult {
                id: item.id,
                installed: false,
                version: None,
                path: None,
            },
        }
    });
    Ok(futures::future::join_all(futures).await)
}
