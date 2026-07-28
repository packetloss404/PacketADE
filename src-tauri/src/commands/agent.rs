//! Tauri command wrappers for CLI agent detection.
//!
//! Two commands are exposed:
//! - [`detect_agent`] — legacy boolean probe (kept for back-compat).
//! - [`detect_cli_catalog`] — bulk probe that also captures version + path.
//!
//! The boolean command is implemented in terms of the catalog command so
//! the two can never drift.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketCodeProviderSummary {
    pub configured: usize,
    pub ready: usize,
    pub warning: usize,
    pub failed: usize,
}

#[derive(Debug, Deserialize)]
struct PacketCodeDoctorReport {
    schema_version: u32,
    status: String,
    effective_home: Option<String>,
    home_source: Option<String>,
    provider_summary: PacketCodeProviderSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketCodeIntegrationProbe {
    pub healthy: bool,
    pub executable_path: String,
    pub version: String,
    pub exit_code: Option<i32>,
    pub schema_version: u32,
    pub doctor_status: String,
    pub effective_home: Option<String>,
    pub home_source: Option<String>,
    pub provider_summary: PacketCodeProviderSummary,
    pub doctor: serde_json::Value,
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
            let installed = if item.id == "packetcode" {
                version.as_deref().is_some_and(agent::is_packetcode_version)
            } else {
                version.is_some()
            };
            return DetectCatalogResult {
                id: item.id,
                installed,
                version,
                path: Some(manual.to_string()),
            };
        }

        match agent::resolve_catalog_path(&item.id, &item.binary).await {
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
                let installed = if item.id == "packetcode" {
                    version.as_deref().is_some_and(agent::is_packetcode_version)
                } else {
                    true
                };
                DetectCatalogResult {
                    id: item.id,
                    installed,
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

/// Verify the complete PacketADE ↔ PacketCode integration contract:
/// executable identity, version handshake, isolated data home, and the
/// machine-readable doctor report. The doctor JSON is returned even when its
/// own status is `fail`, allowing the UI to present actionable findings.
#[tauri::command]
pub async fn probe_packetcode_integration(
    manual_path: Option<String>,
    data_home: Option<String>,
) -> Result<PacketCodeIntegrationProbe, String> {
    let executable_path = if let Some(manual) = manual_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        if !agent::is_executable_file(manual) {
            return Err(format!(
                "PacketCode executable is missing or not executable: {}",
                manual
            ));
        }
        manual.to_string()
    } else {
        agent::resolve_catalog_path("packetcode", "packetcode")
            .await
            .ok_or_else(|| {
                "PacketCode was not found on PATH or in a documented install location".to_string()
            })?
    };

    let version = agent::probe_version_at(&executable_path)
        .await
        .filter(|version| agent::is_packetcode_version(version))
        .ok_or_else(|| {
            format!(
                "{} did not satisfy the PacketCode --version contract",
                executable_path
            )
        })?;

    let data_home = data_home
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    if let Some(home) = data_home.as_deref() {
        if !Path::new(home).is_absolute() {
            return Err(format!(
                "PACKETCODE_HOME must be an absolute path: {}",
                home
            ));
        }
    }

    let mut command = TokioCommand::new(&executable_path);
    command.args(["doctor", "--json"]);
    if let Some(home) = data_home.as_deref() {
        command.env("PACKETCODE_HOME", home);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("Could not start PacketCode doctor: {}", error))?;
    let output = timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| "PacketCode doctor timed out after 15 seconds".to_string())?
        .map_err(|error| format!("PacketCode doctor failed: {}", error))?;
    if output.stdout.len() > crate::commands::MAX_INPUT_SIZE {
        return Err("PacketCode doctor output exceeded the 1 MB safety limit".to_string());
    }

    let doctor_value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail: String = stderr.chars().take(500).collect();
            format!(
                "PacketCode doctor returned invalid JSON: {}{}",
                error,
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!(" ({})", detail.trim())
                }
            )
        })?;
    let doctor: PacketCodeDoctorReport =
        serde_json::from_value(doctor_value.clone()).map_err(|error| {
            format!(
                "PacketCode doctor JSON is missing required integration fields: {}",
                error
            )
        })?;
    let healthy = output.status.success() && doctor.status != "fail";

    Ok(PacketCodeIntegrationProbe {
        healthy,
        executable_path,
        version,
        exit_code: output.status.code(),
        schema_version: doctor.schema_version,
        doctor_status: doctor.status,
        effective_home: doctor.effective_home,
        home_source: doctor.home_source,
        provider_summary: doctor.provider_summary,
        doctor: doctor_value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packetcode_doctor_contract_deserializes_additive_schema_one_report() {
        let report: PacketCodeDoctorReport = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "status": "warn",
            "effective_home": "C:\\PacketCodeData",
            "home_source": "environment",
            "provider_summary": {
                "configured": 2,
                "ready": 1,
                "warning": 1,
                "failed": 0
            },
            "checks": []
        }))
        .expect("doctor contract");
        assert_eq!(report.schema_version, 1);
        assert_eq!(report.provider_summary.ready, 1);
    }
}
