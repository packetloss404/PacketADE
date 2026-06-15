//! Per-conversation checkpoints — named snapshots of message history.
//!
//! Storage: `<home>/.packetade/conversations/<session_id>/checkpoints/<ts>_<chk_id>.json`.
//! The frontend owns when to call `save_checkpoint` (typically on the done event) and
//! treats the stored JSON as opaque.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::warn;

use super::shared::home_dir;
use crate::core::brand::DATA_DIR_NAME;

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("id cannot be empty".to_string());
    }
    if id.contains('/') || id.contains('\\') {
        return Err("id cannot contain path separators".to_string());
    }
    if id == "." || id == ".." || id.contains("..") {
        return Err("id cannot traverse paths".to_string());
    }
    Ok(())
}

fn checkpoints_dir(session_id: &str) -> Result<PathBuf, String> {
    validate_id(session_id)?;
    let home = home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(PathBuf::from(home)
        .join(DATA_DIR_NAME)
        .join("conversations")
        .join(session_id)
        .join("checkpoints"))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn gen_chk_id() -> String {
    format!("chk_{}", now_ms())
}

#[tauri::command]
pub fn save_checkpoint(session_id: String, data: String) -> Result<String, String> {
    let dir = checkpoints_dir(&session_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create checkpoint dir: {}", e))?;

    let chk_id = gen_chk_id();
    let ts = now_ms();
    let filename = format!("{}_{}.json", ts, chk_id);
    let path = dir.join(&filename);
    fs::write(&path, data).map_err(|e| format!("Failed to write checkpoint: {}", e))?;
    Ok(chk_id)
}

#[tauri::command]
pub fn list_checkpoints(session_id: String) -> Result<Vec<String>, String> {
    let dir = checkpoints_dir(&session_id)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let read_dir = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) => {
            warn!("Failed to read checkpoints dir: {}", e);
            return Ok(Vec::new());
        }
    };

    // Collect (filename, content) then sort by filename descending (newest first by ts prefix).
    let mut entries: Vec<(String, String)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if n.ends_with(".json") => n.to_string(),
            _ => continue,
        };
        match fs::read_to_string(&path) {
            Ok(c) => entries.push((name, c)),
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Skipping unreadable checkpoint");
                continue;
            }
        }
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries.into_iter().map(|(_, c)| c).collect())
}

#[tauri::command]
pub fn delete_checkpoint(session_id: String, checkpoint_id: String) -> Result<(), String> {
    validate_id(&checkpoint_id)?;
    let dir = checkpoints_dir(&session_id)?;
    if !dir.exists() {
        return Ok(());
    }
    let read_dir = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    let suffix = format!("_{}.json", checkpoint_id);
    for entry in read_dir.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.ends_with(&suffix) {
                let _ = fs::remove_file(&path);
                return Ok(());
            }
        }
    }
    Ok(())
}
