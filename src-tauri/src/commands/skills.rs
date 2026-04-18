//! Claude-Code-style Skills discovery.
//!
//! Scans `<home>/.claude/skills/<name>/SKILL.md` and
//! `<project>/.claude/skills/<name>/SKILL.md`. Each `SKILL.md` has YAML
//! frontmatter (`name`, `description`, optional `argument-hint`,
//! `disable-model-invocation`, `user-invocable`) followed by a markdown body.
//! Project skills override globals when names collide. When a skill is
//! invoked the body is sent verbatim as a user message.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

use super::shared::home_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDef {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub user_invocable: bool,
    pub source: String,
    pub body: String,
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    argument_hint: Option<String>,
    disable_model_invocation: Option<bool>,
    user_invocable: Option<bool>,
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" => Some(false),
        _ => None,
    }
}

fn unquote(raw: &str) -> String {
    let trimmed = raw.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

/// Parse YAML frontmatter delimited by `---` lines at the top of the file.
/// Returns the parsed frontmatter and the remaining body. If no frontmatter
/// is present, returns defaults plus the entire raw text as body.
fn parse_frontmatter(raw: &str) -> (Frontmatter, String) {
    let mut fm = Frontmatter::default();
    let mut lines = raw.lines();
    let Some(first) = lines.next() else {
        return (fm, String::new());
    };
    if first.trim() != "---" {
        return (fm, raw.to_string());
    }

    let mut consumed = first.len() + 1;
    for line in lines.by_ref() {
        consumed += line.len() + 1;
        if line.trim() == "---" {
            let body = raw.get(consumed..).unwrap_or("").trim_start_matches('\n');
            return (fm, body.to_string());
        }
        if let Some((key, val)) = line.split_once(':') {
            let k = key.trim();
            let v = unquote(val);
            match k {
                "name" => fm.name = Some(v),
                "description" => fm.description = Some(v),
                "argument-hint" | "argument_hint" => fm.argument_hint = Some(v),
                "disable-model-invocation" | "disable_model_invocation" => {
                    fm.disable_model_invocation = parse_bool(&v);
                }
                "user-invocable" | "user_invocable" => {
                    fm.user_invocable = parse_bool(&v);
                }
                _ => {}
            }
        }
    }
    // Malformed: missing closing `---`. Treat as no frontmatter.
    (Frontmatter::default(), raw.to_string())
}

fn scan_dir(skills_root: &Path, source_tag: &str, out: &mut Vec<SkillDef>) {
    let read_dir = match fs::read_dir(skills_root) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let raw = match fs::read_to_string(&skill_md) {
            Ok(s) => s,
            Err(e) => {
                warn!(path = %skill_md.display(), error = %e, "Skipping unreadable SKILL.md");
                continue;
            }
        };
        let (fm, body) = parse_frontmatter(&raw);
        let dir_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm
            .name
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(dir_name);
        if name.is_empty() {
            warn!(path = %skill_md.display(), "Skipping skill with empty name");
            continue;
        }
        let description = fm.description.unwrap_or_default();
        if description.trim().is_empty() {
            warn!(path = %skill_md.display(), "Skipping skill with no description");
            continue;
        }
        // Honor `disable-model-invocation: true` by skipping. The flag exists
        // to keep skills out of automatic model picks; for the manual `/`
        // picker we still want to expose them only when user-invocable.
        // Spec defaults user-invocable to true.
        if fm.disable_model_invocation.unwrap_or(false) && !fm.user_invocable.unwrap_or(true) {
            continue;
        }
        let user_invocable = fm.user_invocable.unwrap_or(true);
        let body_trimmed = body.trim().to_string();
        if body_trimmed.is_empty() {
            warn!(path = %skill_md.display(), "Skipping skill with empty body");
            continue;
        }
        out.push(SkillDef {
            name,
            description,
            argument_hint: fm.argument_hint,
            user_invocable,
            source: source_tag.to_string(),
            body: body_trimmed,
        });
    }
}

#[tauri::command]
pub fn list_skills(project_path: String) -> Result<Vec<SkillDef>, String> {
    let mut global_skills: Vec<SkillDef> = Vec::new();
    if let Some(home) = home_dir() {
        let dir = PathBuf::from(home).join(".claude").join("skills");
        scan_dir(&dir, "global", &mut global_skills);
    }

    let mut project_skills: Vec<SkillDef> = Vec::new();
    if !project_path.is_empty() {
        let dir = PathBuf::from(&project_path).join(".claude").join("skills");
        scan_dir(&dir, "project", &mut project_skills);
    }

    // Project overrides global by name.
    let mut by_name: std::collections::HashMap<String, SkillDef> =
        std::collections::HashMap::new();
    for s in global_skills {
        by_name.insert(s.name.clone(), s);
    }
    for s in project_skills {
        by_name.insert(s.name.clone(), s);
    }

    let mut out: Vec<SkillDef> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
