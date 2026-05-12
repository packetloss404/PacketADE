use super::helpers::{iso_to_epoch, now_epoch_seconds, STALE_SECONDS};
use crate::commands::shared::home_dir;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

/// Status data extracted from Gemini CLI's session logs.
/// Gemini stores conversation logs in ~/.gemini/tmp/<sandbox>/logs.json.
/// Unlike Claude, there's no dedicated statusline protocol — we read
/// session logs to extract model and activity data.
#[derive(Debug, Serialize, Clone)]
pub struct GeminiStatusLineData {
    pub session_id: String,
    pub model: String,
    pub cwd: String,
    pub message_count: u32,
    pub last_role: String,
    pub timestamp: u64,
}

#[tauri::command]
pub fn read_gemini_statusline_states() -> Vec<GeminiStatusLineData> {
    let home = match home_dir() {
        Some(h) => h,
        None => return vec![],
    };

    let tmp_dir = PathBuf::from(&home).join(".gemini").join("tmp");
    let sandboxes = match fs::read_dir(&tmp_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    // Read projects.json to map sandbox names to directory paths
    let projects_path = PathBuf::from(&home).join(".gemini").join("projects.json");
    let project_map = read_project_map(&projects_path);

    let now = now_epoch_seconds();
    let mut results = Vec::new();

    for entry in sandboxes.flatten() {
        let sandbox_path = entry.path();
        if !sandbox_path.is_dir() {
            continue;
        }

        let sandbox_name = match sandbox_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let logs_path = sandbox_path.join("logs.json");
        if !logs_path.exists() {
            continue;
        }

        // Check file modification time for staleness
        if let Ok(meta) = fs::metadata(&logs_path) {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
                    if age.as_secs() > STALE_SECONDS {
                        continue;
                    }
                }
            }
        }

        let content = match fs::read_to_string(&logs_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let entries: Vec<serde_json::Value> = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if entries.is_empty() {
            continue;
        }

        // Extract from the latest entry
        let last = &entries[entries.len() - 1];
        let session_id = last
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let last_role = last
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let timestamp_str = last.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = iso_to_epoch(timestamp_str);

        // Skip if the last message is stale
        if timestamp > 0 && now.saturating_sub(timestamp) > STALE_SECONDS {
            continue;
        }

        // Find model from the most recent assistant message with model info
        let model = entries
            .iter()
            .rev()
            .filter_map(|e| e.get("model").and_then(|v| v.as_str()))
            .next()
            .unwrap_or("Gemini")
            .to_string();

        // Resolve sandbox name to project directory path
        let cwd = project_map
            .iter()
            .find(|(_, v)| v.as_str() == sandbox_name)
            .map(|(k, _)| k.clone())
            .unwrap_or_default();

        results.push(GeminiStatusLineData {
            session_id,
            model,
            cwd,
            message_count: entries.len() as u32,
            last_role,
            timestamp: if timestamp > 0 { timestamp } else { now },
        });
    }

    results
}

/// Read ~/.gemini/projects.json to map directory paths to sandbox names.
fn read_project_map(path: &PathBuf) -> Vec<(String, String)> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let projects = match parsed.get("projects").and_then(|v| v.as_object()) {
        Some(p) => p,
        None => return vec![],
    };

    projects
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}
