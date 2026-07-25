use super::helpers::{now_epoch_seconds, STALE_SECONDS};
use crate::commands::shared::home_dir;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

/// Status data extracted from OpenCode's state files.
/// OpenCode stores data in:
///   ~/.local/state/opencode/model.json — current model
///   ~/.local/share/opencode/opencode.db — session database (SQLite)
/// We read the model file and check DB modification time for activity.
#[derive(Debug, Serialize, Clone)]
pub struct OpenCodeStatusLineData {
    pub model: String,
    pub provider: String,
    pub cwd: String,
    pub timestamp: u64,
}

// Polled on mount + every 5s. Blocking fs work runs off the main thread via
// `spawn_blocking` so it never freezes the window.
#[tauri::command]
pub async fn read_opencode_statusline_states() -> Vec<OpenCodeStatusLineData> {
    tokio::task::spawn_blocking(read_opencode_statusline_states_blocking)
        .await
        .unwrap_or_default()
}

fn read_opencode_statusline_states_blocking() -> Vec<OpenCodeStatusLineData> {
    let home = match home_dir() {
        Some(h) => h,
        None => return vec![],
    };

    let home_path = PathBuf::from(&home);
    let now = now_epoch_seconds();

    // Determine state and data dirs (XDG on all platforms, with Windows fallback)
    let state_dir = resolve_xdg_dir(&home_path, "state");
    let data_dir = resolve_xdg_dir(&home_path, "share");

    // Check if the database has been modified recently
    let db_path = data_dir.join("opencode.db");
    let db_active = is_recently_modified(&db_path, STALE_SECONDS);
    if !db_active {
        return vec![];
    }

    let db_timestamp = file_modified_epoch(&db_path).unwrap_or(now);

    // Read current model from model.json
    let model_path = state_dir.join("model.json");
    let (model, provider) = read_current_model(&model_path);

    // Try to get the working directory from the most recent session
    // OpenCode doesn't expose cwd in a simple file, so we leave it empty
    // and the frontend will match on timestamp recency instead.
    vec![OpenCodeStatusLineData {
        model,
        provider,
        cwd: String::new(),
        timestamp: db_timestamp,
    }]
}

fn resolve_xdg_dir(home: &PathBuf, subdir: &str) -> PathBuf {
    // Check XDG env vars first
    let env_key = match subdir {
        "state" => "XDG_STATE_HOME",
        "share" => "XDG_DATA_HOME",
        _ => "",
    };

    if !env_key.is_empty() {
        if let Ok(val) = std::env::var(env_key) {
            return PathBuf::from(val).join("opencode");
        }
    }

    // Windows: check AppData\Local
    #[cfg(windows)]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let win_path = PathBuf::from(&local_app_data).join("opencode");
            if win_path.exists() {
                return win_path;
            }
        }
    }

    // Default XDG paths
    match subdir {
        "state" => home.join(".local").join("state").join("opencode"),
        "share" => home.join(".local").join("share").join("opencode"),
        _ => home.join(".local").join(subdir).join("opencode"),
    }
}

fn is_recently_modified(path: &PathBuf, max_age_secs: u64) -> bool {
    if let Ok(meta) = fs::metadata(path) {
        if let Ok(modified) = meta.modified() {
            if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
                return age.as_secs() <= max_age_secs;
            }
        }
    }
    false
}

fn file_modified_epoch(path: &PathBuf) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(epoch.as_secs())
}

/// Read the current model from OpenCode's model.json state file.
/// Returns (model_id, provider_id).
fn read_current_model(path: &PathBuf) -> (String, String) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return ("Unknown".to_string(), "unknown".to_string()),
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return ("Unknown".to_string(), "unknown".to_string()),
    };

    // Use the first entry in "recent" as the current model
    if let Some(recent) = parsed.get("recent").and_then(|v| v.as_array()) {
        if let Some(first) = recent.first() {
            let model = first
                .get("modelID")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let provider = first
                .get("providerID")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            return (model, provider);
        }
    }

    ("Unknown".to_string(), "unknown".to_string())
}
