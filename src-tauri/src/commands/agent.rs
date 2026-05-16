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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectCatalogItem {
    pub id: String,
    pub binary: String,
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
        match agent::resolve_path(&item.binary).await {
            Some(path) => {
                let version = agent::probe_version(&item.binary).await;
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
