//! Claude-Code-style custom sub-agent discovery.
//!
//! Scans `<home>/.claude/agents/<name>.md` and
//! `<project>/.claude/agents/<name>.md`. Each file has YAML frontmatter
//! (`name`, `description`, optional `model`, `color`, `tools`) followed
//! by a markdown body that becomes the sub-agent's system prompt.
//! Project agents override globals when names collide.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

use crate::core::shared::home_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentDef {
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    pub color: Option<String>,
    pub allowed_tools: Vec<String>,
    pub system_prompt: String,
    pub source: String,
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    model: Option<String>,
    color: Option<String>,
    tools: Option<Vec<String>>,
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

/// Parse a `tools` value that may be either a YAML flow array (`[a, b, c]`)
/// or a comma-separated string (`a, b, c`). Returns an empty vec for an
/// empty value (so the agent falls back to the read-only default set).
fn parse_tools_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    let inner = if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    inner
        .split(',')
        .map(|s| unquote(s))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Parse YAML frontmatter delimited by `---` lines at the top of the file.
/// Returns the parsed frontmatter and the remaining body.
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
                "model" => fm.model = Some(v),
                "color" => fm.color = Some(v),
                "tools" => fm.tools = Some(parse_tools_list(val)),
                _ => {}
            }
        }
    }
    // Malformed: missing closing `---`. Treat as no frontmatter.
    (Frontmatter::default(), raw.to_string())
}

fn scan_dir(agents_root: &Path, source_tag: &str, out: &mut Vec<CustomAgentDef>) {
    let read_dir = match fs::read_dir(agents_root) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Skipping unreadable agent .md");
                continue;
            }
        };
        let (fm, body) = parse_frontmatter(&raw);
        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm
            .name
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(file_stem);
        if name.is_empty() {
            warn!(path = %path.display(), "Skipping agent with empty name");
            continue;
        }
        let description = fm.description.unwrap_or_default();
        if description.trim().is_empty() {
            warn!(path = %path.display(), "Skipping agent with no description");
            continue;
        }
        let body_trimmed = body.trim().to_string();
        if body_trimmed.is_empty() {
            warn!(path = %path.display(), "Skipping agent with empty body");
            continue;
        }
        out.push(CustomAgentDef {
            name,
            description,
            model: fm.model,
            color: fm.color,
            allowed_tools: fm.tools.unwrap_or_default(),
            system_prompt: body_trimmed,
            source: source_tag.to_string(),
        });
    }
}

/// Shared discovery helper used by both the Tauri command and the tool runtime.
pub fn discover_custom_agents(project_path: &str) -> Vec<CustomAgentDef> {
    let mut global_agents: Vec<CustomAgentDef> = Vec::new();
    if let Some(home) = home_dir() {
        let dir = PathBuf::from(home).join(".claude").join("agents");
        scan_dir(&dir, "global", &mut global_agents);
    }

    let mut project_agents: Vec<CustomAgentDef> = Vec::new();
    if !project_path.is_empty() {
        let dir = PathBuf::from(project_path).join(".claude").join("agents");
        // A project agent definition is repo-supplied prompt + tool authority
        // that gets advertised to the model. Only a trusted project may
        // contribute one; an untrusted clone falls back to global agents.
        if dir.is_dir() {
            if crate::core::project_trust::is_project_trusted(project_path) {
                scan_dir(&dir, "project", &mut project_agents);
            } else {
                warn!(
                    target: "packetbench::trust",
                    path = %dir.display(),
                    "project .claude/agents ignored: project is not in the trusted-projects list"
                );
            }
        }
    }

    // Project overrides global by name.
    let mut by_name: std::collections::HashMap<String, CustomAgentDef> =
        std::collections::HashMap::new();
    for a in global_agents {
        by_name.insert(a.name.clone(), a);
    }
    for a in project_agents {
        by_name.insert(a.name.clone(), a);
    }

    let mut out: Vec<CustomAgentDef> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}
