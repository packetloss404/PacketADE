//! User-defined slash commands.
//!
//! Scans `<home>/.packetade/commands/*.md` and `<project>/.packetade/commands/*.md`,
//! parsing each file as optional YAML frontmatter + markdown body. Project overrides global.
//!
//! Legacy `.packetcode/commands/` directories are also scanned for backwards compat.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

use super::shared::home_dir;
use crate::core::brand::{DATA_DIR_NAME, LEGACY_DATA_DIR_NAME};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommandDef {
    pub name: String,
    pub description: String,
    pub body: String,
    pub source: String,
}

fn is_valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Parse optional frontmatter. Returns (name_opt, description_opt, body).
fn parse_frontmatter(raw: &str) -> (Option<String>, Option<String>, String) {
    let mut lines = raw.lines();
    if let Some(first) = lines.next() {
        if first.trim() == "---" {
            let mut name: Option<String> = None;
            let mut desc: Option<String> = None;
            let mut consumed = first.len() + 1;
            for line in lines.by_ref() {
                consumed += line.len() + 1;
                if line.trim() == "---" {
                    let body = raw.get(consumed..).unwrap_or("").trim_start_matches('\n');
                    return (name, desc, body.to_string());
                }
                if let Some((key, val)) = line.split_once(": ") {
                    let k = key.trim();
                    let v = val.trim().trim_matches('"').trim_matches('\'').to_string();
                    if k == "name" {
                        name = Some(v);
                    } else if k == "description" {
                        desc = Some(v);
                    }
                }
            }
            // Malformed — no closing delimiter; treat whole body as body.
        }
    }
    (None, None, raw.to_string())
}

fn scan_dir(dir: &Path, source_tag: &str, out: &mut Vec<SlashCommandDef>) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Skipping unreadable slash command");
                continue;
            }
        };
        let (fm_name, fm_desc, body) = parse_frontmatter(&raw);
        let fallback_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let name = fm_name.unwrap_or(fallback_name);
        if !is_valid_name(&name) {
            warn!(path = %path.display(), name = %name, "Skipping slash command with invalid name");
            continue;
        }
        let description = fm_desc.unwrap_or_else(|| {
            body.lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .to_string()
        });
        let body_trimmed = body.trim().to_string();
        if body_trimmed.is_empty() {
            continue;
        }
        out.push(SlashCommandDef {
            name,
            description,
            body: body_trimmed,
            source: source_tag.to_string(),
        });
    }
}

#[tauri::command]
pub fn list_slash_commands(project_path: String) -> Result<Vec<SlashCommandDef>, String> {
    let mut global_cmds: Vec<SlashCommandDef> = Vec::new();
    if let Some(home) = home_dir() {
        // Scan legacy first so new-name files win on conflict.
        let legacy_dir = PathBuf::from(&home).join(LEGACY_DATA_DIR_NAME).join("commands");
        scan_dir(&legacy_dir, "global", &mut global_cmds);
        let dir = PathBuf::from(home).join(DATA_DIR_NAME).join("commands");
        scan_dir(&dir, "global", &mut global_cmds);
    }

    let mut project_cmds: Vec<SlashCommandDef> = Vec::new();
    if !project_path.is_empty() {
        let legacy_dir = PathBuf::from(&project_path)
            .join(LEGACY_DATA_DIR_NAME)
            .join("commands");
        scan_dir(&legacy_dir, "project", &mut project_cmds);
        let dir = PathBuf::from(&project_path)
            .join(DATA_DIR_NAME)
            .join("commands");
        scan_dir(&dir, "project", &mut project_cmds);
    }

    // Project overrides global by name.
    let mut by_name: std::collections::HashMap<String, SlashCommandDef> =
        std::collections::HashMap::new();
    for c in global_cmds {
        by_name.insert(c.name.clone(), c);
    }
    for c in project_cmds {
        by_name.insert(c.name.clone(), c);
    }

    let mut out: Vec<SlashCommandDef> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
