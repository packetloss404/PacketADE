//! Persistence for API agent conversations.
//!
//! Stores each conversation as a JSON file under
//! `<home>/.packetcode/conversations/<id>.json`. The frontend is responsible
//! for the JSON schema; this module treats `data` as an opaque, pre-serialized
//! string and only does filesystem management + basic path-escape guards.

use std::fs;
use std::path::PathBuf;
use tracing::warn;

use super::shared::home_dir;

/// Resolve the conversations directory (`<home>/.packetcode/conversations`).
fn conversations_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(PathBuf::from(home)
        .join(".packetcode")
        .join("conversations"))
}

/// Validate a conversation id against path-escape tricks.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("Conversation id cannot be empty".to_string());
    }
    if id.contains('/') || id.contains('\\') {
        return Err("Conversation id cannot contain path separators".to_string());
    }
    if id == "." || id == ".." || id.contains("..") {
        return Err("Conversation id cannot traverse paths".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn save_conversation(id: String, data: String) -> Result<(), String> {
    validate_id(&id)?;
    let dir = conversations_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create conversations dir: {}", e))?;

    let file_path = dir.join(format!("{}.json", id));
    fs::write(&file_path, data)
        .map_err(|e| format!("Failed to write conversation: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn load_conversations() -> Result<Vec<String>, String> {
    let dir = conversations_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let read_dir = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) => {
            warn!("Failed to read conversations dir: {}", e);
            return Ok(Vec::new());
        }
    };

    let mut out: Vec<String> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(content) => out.push(content),
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Skipping unreadable conversation file");
                continue;
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_conversation_file(id: String) -> Result<(), String> {
    validate_id(&id)?;
    let dir = conversations_dir()?;
    let file_path = dir.join(format!("{}.json", id));
    if !file_path.exists() {
        return Ok(());
    }
    fs::remove_file(&file_path)
        .map_err(|e| format!("Failed to delete conversation: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_rejects_empty() {
        assert!(validate_id("").is_err());
    }

    #[test]
    fn validate_id_rejects_slashes() {
        assert!(validate_id("foo/bar").is_err());
        assert!(validate_id("foo\\bar").is_err());
    }

    #[test]
    fn validate_id_rejects_traversal() {
        assert!(validate_id("..").is_err());
        assert!(validate_id(".").is_err());
        assert!(validate_id("a..b").is_err());
    }

    #[test]
    fn validate_id_accepts_normal_ids() {
        assert!(validate_id("abc-123").is_ok());
        assert!(validate_id("conv_42").is_ok());
    }
}
