//! Persistence for API agent conversations.
//!
//! Stores each conversation as a JSON file under
//! `<home>/.packetade/conversations/<id>.json`. The frontend is responsible
//! for the JSON schema; this module treats `data` as an opaque, pre-serialized
//! string and only does filesystem management + basic path-escape guards.

use std::fs;
use std::path::PathBuf;
use tracing::warn;

use super::shared::home_dir;
use crate::core::brand::DATA_DIR_NAME;

/// Resolve the conversations directory (`<home>/.packetade/conversations`).
fn conversations_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(PathBuf::from(home)
        .join(DATA_DIR_NAME)
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
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create conversations dir: {}", e))?;

    let file_path = dir.join(format!("{}.json", id));
    fs::write(&file_path, data).map_err(|e| format!("Failed to write conversation: {}", e))?;
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
    fs::remove_file(&file_path).map_err(|e| format!("Failed to delete conversation: {}", e))?;
    Ok(())
}

/// Render a conversation's messages as a Markdown string for export.
/// `messages_json` is the serialized Vec<AgentMessage> from the frontend.
#[tauri::command]
pub fn export_conversation_markdown(
    title: String,
    model: String,
    messages_json: String,
) -> Result<String, String> {
    use serde_json::Value;

    let msgs: Value = serde_json::from_str(&messages_json)
        .map_err(|e| format!("Invalid messages JSON: {}", e))?;
    let arr = msgs
        .as_array()
        .ok_or_else(|| "messages JSON must be an array".to_string())?;

    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", title));
    out.push_str(&format!("**Model:** {}\n", model));
    out.push_str(&format!(
        "**Exported:** {}\n\n---\n\n",
        crate::commands::usage::current_timestamp_iso()
    ));

    for msg in arr {
        let role = msg
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let content = msg
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if role == "user" {
            out.push_str("## User\n\n");
            if !content.is_empty() {
                out.push_str(content);
                out.push_str("\n\n");
            }
        } else if role == "assistant" {
            out.push_str("## Assistant\n\n");
            if !content.is_empty() {
                out.push_str(content);
                out.push_str("\n\n");
            }
            if let Some(tool_calls) = msg.get("toolCalls").and_then(|v| v.as_array()) {
                if !tool_calls.is_empty() {
                    out.push_str("### Tool calls\n\n");
                    for tc in tool_calls {
                        let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let status = tc
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown");
                        out.push_str(&format!("- **{}** ({})\n", name, status));
                        if let Some(full) = tc.get("fullContent").and_then(|v| v.as_str()) {
                            let preview: String = full.chars().take(500).collect();
                            out.push_str("  ```\n");
                            for line in preview.lines() {
                                out.push_str("  ");
                                out.push_str(line);
                                out.push('\n');
                            }
                            out.push_str("  ```\n");
                        }
                    }
                    out.push('\n');
                }
            }
        } else if role == "system" {
            if !content.is_empty() {
                out.push_str("## System\n\n");
                out.push_str("> ");
                out.push_str(&content.replace('\n', "\n> "));
                out.push_str("\n\n");
            }
        }
    }

    Ok(out)
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
