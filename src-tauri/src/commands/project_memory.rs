//! Human-readable, project-local Markdown memory.
//!
//! The repository deliberately derives its graph and revisions from files.
//! There is no side database and no implicit migration of PacketBench's existing
//! global memory. All user-provided identifiers are resolved by scanning the
//! confined `.agents/memory` directory, so callers never supply a file path.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, State};
use tempfile::NamedTempFile;
use uuid::Uuid;

pub const PROJECT_MEMORY_DIR: &str = ".agents/memory";
pub const PROJECT_MEMORY_SCHEMA_VERSION: u32 = 1;
pub const MAX_PROJECT_MEMORY_NOTES: usize = 2_000;
pub const MAX_PROJECT_MEMORY_NOTE_BYTES: usize = 256 * 1024;
pub const MAX_PROJECT_MEMORY_QUERY_BYTES: usize = 4 * 1024;
const MAX_SEARCH_RESULTS: usize = 20;
const MAX_SEARCH_EXCERPT: usize = 600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryMetadata {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub provenance_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryNote {
    pub metadata: ProjectMemoryMetadata,
    pub body: String,
    pub revision: String,
    pub relative_path: String,
    pub outbound_ids: Vec<String>,
    pub backlink_ids: Vec<String>,
    pub broken_links: Vec<String>,
    pub orphaned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryWarning {
    pub relative_path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemorySnapshot {
    pub schema_version: u32,
    pub directory: String,
    pub notes: Vec<ProjectMemoryNote>,
    pub warnings: Vec<ProjectMemoryWarning>,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemorySearchResult {
    pub id: String,
    pub title: String,
    pub relative_path: String,
    pub excerpt: String,
    pub score: f64,
    pub provenance_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectMemoryInput {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub provenance_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectMemoryInput {
    pub id: String,
    pub expected_revision: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub provenance_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemoryChanged {
    project_path: String,
}

pub struct ProjectMemoryWatchState {
    watchers: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

impl Default for ProjectMemoryWatchState {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn project_root(project_path: &str) -> Result<PathBuf, String> {
    super::validate_project_path(project_path)?;
    fs::canonicalize(project_path).map_err(|error| format!("Cannot resolve project path: {error}"))
}

fn memory_root(project_path: &str, create: bool) -> Result<PathBuf, String> {
    let project = project_root(project_path)?;
    let root = project.join(PROJECT_MEMORY_DIR);
    if create {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Cannot create project memory directory: {error}"))?;
    }
    if !root.exists() {
        return Ok(root);
    }
    let canonical = fs::canonicalize(&root)
        .map_err(|error| format!("Cannot resolve project memory directory: {error}"))?;
    if !canonical.starts_with(&project) {
        return Err("Project memory directory escapes the project root".to_string());
    }
    Ok(canonical)
}

fn revision(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}

fn normalize_list(values: Vec<String>, max: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| {
            !value.is_empty() && value.len() <= 160 && seen.insert(value.to_ascii_lowercase())
        })
        .take(max)
        .collect()
}

fn validate_content(title: &str, body: &str) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 200 {
        return Err("Title must be between 1 and 200 bytes".to_string());
    }
    if body.as_bytes().contains(&0) {
        return Err("Binary content is not allowed in project memory".to_string());
    }
    if body.len() > MAX_PROJECT_MEMORY_NOTE_BYTES {
        return Err(format!(
            "Note exceeds the {} byte project-memory limit",
            MAX_PROJECT_MEMORY_NOTE_BYTES
        ));
    }
    if suspected_secret(body) {
        return Err(
            "Content looks like it contains a secret. Redact credentials before saving."
                .to_string(),
        );
    }
    Ok(())
}

pub fn suspected_secret(value: &str) -> bool {
    if value.contains("-----BEGIN PRIVATE KEY-----")
        || value.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
    {
        return true;
    }
    Regex::new(
        r#"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}"#,
    )
    .map(|pattern| pattern.is_match(value))
    .unwrap_or(true)
}

fn slug(title: &str) -> String {
    let value = title
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let collapsed = Regex::new("-+")
        .map(|pattern| pattern.replace_all(&value, "-").to_string())
        .unwrap_or(value);
    let trimmed = collapsed.trim_matches('-');
    if trimmed.is_empty() {
        "note".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn render_note(metadata: &ProjectMemoryMetadata, body: &str) -> Result<String, String> {
    let yaml = serde_yaml::to_string(metadata)
        .map_err(|error| format!("Cannot encode project-memory metadata: {error}"))?;
    Ok(format!("---\n{}---\n{}\n", yaml, body.trim_end()))
}

fn parse_note(path: &Path, root: &Path) -> Result<ProjectMemoryNote, ProjectMemoryWarning> {
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let metadata = fs::symlink_metadata(path).map_err(|error| ProjectMemoryWarning {
        relative_path: relative.clone(),
        code: "unreadable".to_string(),
        message: error.to_string(),
    })?;
    if metadata.file_type().is_symlink() {
        return Err(ProjectMemoryWarning {
            relative_path: relative,
            code: "symlink_rejected".to_string(),
            message: "Symlinked notes are not read".to_string(),
        });
    }
    if metadata.len() as usize > MAX_PROJECT_MEMORY_NOTE_BYTES {
        return Err(ProjectMemoryWarning {
            relative_path: relative,
            code: "oversized".to_string(),
            message: "Note exceeds the project-memory size limit".to_string(),
        });
    }
    let raw = fs::read(path).map_err(|error| ProjectMemoryWarning {
        relative_path: relative.clone(),
        code: "unreadable".to_string(),
        message: error.to_string(),
    })?;
    if raw.contains(&0) {
        return Err(ProjectMemoryWarning {
            relative_path: relative,
            code: "binary_rejected".to_string(),
            message: "Binary content is not read".to_string(),
        });
    }
    let text = String::from_utf8(raw.clone()).map_err(|_| ProjectMemoryWarning {
        relative_path: relative.clone(),
        code: "invalid_utf8".to_string(),
        message: "Note is not valid UTF-8".to_string(),
    })?;
    let normalized = text.replace("\r\n", "\n");
    let rest = normalized
        .strip_prefix("---\n")
        .ok_or_else(|| ProjectMemoryWarning {
            relative_path: relative.clone(),
            code: "malformed_frontmatter".to_string(),
            message: "Missing YAML frontmatter".to_string(),
        })?;
    let (yaml, body) = rest
        .split_once("\n---\n")
        .ok_or_else(|| ProjectMemoryWarning {
            relative_path: relative.clone(),
            code: "malformed_frontmatter".to_string(),
            message: "Unterminated YAML frontmatter".to_string(),
        })?;
    let metadata: ProjectMemoryMetadata =
        serde_yaml::from_str(yaml).map_err(|error| ProjectMemoryWarning {
            relative_path: relative.clone(),
            code: "malformed_frontmatter".to_string(),
            message: error.to_string(),
        })?;
    if metadata.schema_version != PROJECT_MEMORY_SCHEMA_VERSION {
        return Err(ProjectMemoryWarning {
            relative_path: relative,
            code: "unsupported_schema".to_string(),
            message: format!(
                "Schema {} is not supported by this PacketBench build",
                metadata.schema_version
            ),
        });
    }
    if metadata.id.trim().is_empty() || metadata.title.trim().is_empty() {
        return Err(ProjectMemoryWarning {
            relative_path: relative,
            code: "invalid_metadata".to_string(),
            message: "Note id and title are required".to_string(),
        });
    }
    Ok(ProjectMemoryNote {
        metadata,
        body: body.trim_end().to_string(),
        revision: revision(&raw),
        relative_path: relative,
        outbound_ids: Vec::new(),
        backlink_ids: Vec::new(),
        broken_links: Vec::new(),
        orphaned: false,
    })
}

fn raw_links(body: &str) -> Vec<String> {
    let wiki = Regex::new(r"\[\[([^\]\n]{1,200})\]\]").expect("valid wiki regex");
    let markdown =
        Regex::new(r"\[[^\]\n]*\]\(([^)\n]{1,240}\.md)(?:#[^)\n]*)?\)").expect("valid md regex");
    wiki.captures_iter(body)
        .filter_map(|capture| {
            capture
                .get(1)
                .map(|value| value.as_str().trim().to_string())
        })
        .chain(markdown.captures_iter(body).filter_map(|capture| {
            capture.get(1).map(|value| {
                Path::new(value.as_str())
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            })
        }))
        .collect()
}

fn normalized_title(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn add_graph(notes: &mut [ProjectMemoryNote], warnings: &mut Vec<ProjectMemoryWarning>) {
    let mut by_id: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_stem: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, note) in notes.iter().enumerate() {
        by_id
            .entry(note.metadata.id.clone())
            .or_default()
            .push(index);
        by_title
            .entry(normalized_title(&note.metadata.title))
            .or_default()
            .push(index);
        if let Some(stem) = Path::new(&note.relative_path).file_stem() {
            by_stem
                .entry(normalized_title(&stem.to_string_lossy()))
                .or_default()
                .push(index);
        }
    }
    for (id, matches) in &by_id {
        if matches.len() > 1 {
            warnings.push(ProjectMemoryWarning {
                relative_path: "*".to_string(),
                code: "duplicate_id".to_string(),
                message: format!("Duplicate note id: {id}"),
            });
        }
    }

    let mut edges = Vec::new();
    let mut broken = Vec::new();
    for (source, note) in notes.iter().enumerate() {
        let mut seen = HashSet::new();
        for raw in raw_links(&note.body) {
            let key = normalized_title(&raw);
            let candidates = by_id
                .get(&raw)
                .or_else(|| by_title.get(&key))
                .or_else(|| by_stem.get(&key));
            match candidates {
                Some(matches) if matches.len() == 1 => {
                    let target = matches[0];
                    if seen.insert(target) {
                        edges.push((source, target));
                    }
                }
                Some(_) => warnings.push(ProjectMemoryWarning {
                    relative_path: note.relative_path.clone(),
                    code: "ambiguous_link".to_string(),
                    message: format!("Ambiguous link: {raw}"),
                }),
                None => broken.push((source, raw)),
            }
        }
    }
    for (source, raw) in broken {
        notes[source].broken_links.push(raw);
    }
    for (source, target) in edges {
        let target_id = notes[target].metadata.id.clone();
        let source_id = notes[source].metadata.id.clone();
        notes[source].outbound_ids.push(target_id);
        notes[target].backlink_ids.push(source_id);
    }
    for note in notes {
        note.orphaned = note.outbound_ids.is_empty() && note.backlink_ids.is_empty();
    }
}

pub fn list_project_memory_inner(project_path: &str) -> Result<ProjectMemorySnapshot, String> {
    let root = memory_root(project_path, false)?;
    if !root.exists() {
        return Ok(ProjectMemorySnapshot {
            schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
            directory: PROJECT_MEMORY_DIR.to_string(),
            notes: Vec::new(),
            warnings: Vec::new(),
            revision: revision(&[]),
        });
    }
    let mut notes = Vec::new();
    let mut warnings = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|error| format!("Cannot list project memory: {error}"))?
    {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                warnings.push(ProjectMemoryWarning {
                    relative_path: "*".to_string(),
                    code: "unreadable".to_string(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        match parse_note(&path, &root) {
            Ok(note) => notes.push(note),
            Err(warning) => warnings.push(warning),
        }
        if notes.len() >= MAX_PROJECT_MEMORY_NOTES {
            warnings.push(ProjectMemoryWarning {
                relative_path: "*".to_string(),
                code: "count_limit".to_string(),
                message: format!("Only the first {MAX_PROJECT_MEMORY_NOTES} notes were loaded"),
            });
            break;
        }
    }
    notes.sort_by(|left, right| {
        right
            .metadata
            .updated_at
            .cmp(&left.metadata.updated_at)
            .then_with(|| left.metadata.title.cmp(&right.metadata.title))
    });
    add_graph(&mut notes, &mut warnings);
    let snapshot_revision = revision(
        notes
            .iter()
            .flat_map(|note| note.revision.as_bytes())
            .copied()
            .collect::<Vec<_>>()
            .as_slice(),
    );
    Ok(ProjectMemorySnapshot {
        schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
        directory: PROJECT_MEMORY_DIR.to_string(),
        notes,
        warnings,
        revision: snapshot_revision,
    })
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Project-memory note has no parent directory".to_string())?;
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot create temporary note: {error}"))?;
    temp.write_all(contents.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|error| format!("Cannot write project-memory note: {error}"))?;
    if path.exists() {
        let backup = path.with_extension("md.packetbench-backup");
        fs::copy(path, &backup).map_err(|error| format!("Cannot create note backup: {error}"))?;
        fs::remove_file(path).map_err(|error| format!("Cannot replace note: {error}"))?;
        if let Err(error) = temp.persist(path) {
            let _ = fs::rename(&backup, path);
            return Err(format!(
                "Cannot persist project-memory note: {}",
                error.error
            ));
        }
        let _ = fs::remove_file(backup);
    } else {
        temp.persist(path)
            .map_err(|error| format!("Cannot persist project-memory note: {}", error.error))?;
    }
    Ok(())
}

fn find_note(project_path: &str, id: &str) -> Result<ProjectMemoryNote, String> {
    list_project_memory_inner(project_path)?
        .notes
        .into_iter()
        .find(|note| note.metadata.id == id)
        .ok_or_else(|| "Project-memory note was not found".to_string())
}

pub fn create_project_memory_inner(
    project_path: &str,
    input: CreateProjectMemoryInput,
) -> Result<ProjectMemoryNote, String> {
    validate_content(&input.title, &input.body)?;
    let root = memory_root(project_path, true)?;
    let snapshot = list_project_memory_inner(project_path)?;
    if snapshot.notes.len() >= MAX_PROJECT_MEMORY_NOTES {
        return Err("Project-memory note limit reached".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now_ms();
    let metadata = ProjectMemoryMetadata {
        schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
        id: id.clone(),
        title: input.title.trim().to_string(),
        created_at: timestamp,
        updated_at: timestamp,
        archived: false,
        tags: normalize_list(input.tags, 32),
        provenance_ids: normalize_list(input.provenance_ids, 64),
    };
    let filename = format!("{}-{}.md", slug(&metadata.title), &id[..8]);
    write_atomic(&root.join(filename), &render_note(&metadata, &input.body)?)?;
    find_note(project_path, &id)
}

pub fn update_project_memory_inner(
    project_path: &str,
    input: UpdateProjectMemoryInput,
) -> Result<ProjectMemoryNote, String> {
    validate_content(&input.title, &input.body)?;
    let current = find_note(project_path, &input.id)?;
    if current.revision != input.expected_revision {
        return Err(
            "Project-memory conflict: the note changed outside PacketBench. Reload before saving."
                .to_string(),
        );
    }
    let root = memory_root(project_path, false)?;
    let path = root.join(&current.relative_path);
    let canonical_parent = fs::canonicalize(path.parent().unwrap_or(&root))
        .map_err(|error| format!("Cannot resolve note parent: {error}"))?;
    if canonical_parent != root {
        return Err("Project-memory note escapes the configured directory".to_string());
    }
    let metadata = ProjectMemoryMetadata {
        schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
        id: current.metadata.id.clone(),
        title: input.title.trim().to_string(),
        created_at: current.metadata.created_at,
        updated_at: now_ms(),
        archived: current.metadata.archived,
        tags: normalize_list(input.tags, 32),
        provenance_ids: normalize_list(input.provenance_ids, 64),
    };
    write_atomic(&path, &render_note(&metadata, &input.body)?)?;
    find_note(project_path, &metadata.id)
}

pub fn archive_project_memory_inner(
    project_path: &str,
    id: &str,
    expected_revision: &str,
) -> Result<ProjectMemoryNote, String> {
    let current = find_note(project_path, id)?;
    if current.revision != expected_revision {
        return Err(
            "Project-memory conflict: the note changed outside PacketBench. Reload before archiving."
                .to_string(),
        );
    }
    let root = memory_root(project_path, false)?;
    let path = root.join(&current.relative_path);
    let mut metadata = current.metadata.clone();
    metadata.archived = true;
    metadata.updated_at = now_ms();
    write_atomic(&path, &render_note(&metadata, &current.body)?)?;
    find_note(project_path, id)
}

fn tokens(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|token| token.len() >= 2)
        .collect()
}

pub fn search_project_memory_inner(
    project_path: &str,
    query: &str,
) -> Result<Vec<ProjectMemorySearchResult>, String> {
    if query.len() > MAX_PROJECT_MEMORY_QUERY_BYTES {
        return Err("Project-memory search query is too long".to_string());
    }
    let query_tokens = tokens(query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }
    let notes = list_project_memory_inner(project_path)?
        .notes
        .into_iter()
        .filter(|note| !note.metadata.archived)
        .collect::<Vec<_>>();
    let document_tokens = notes
        .iter()
        .map(|note| tokens(&format!("{} {}", note.metadata.title, note.body)))
        .collect::<Vec<_>>();
    let mut results = notes
        .iter()
        .enumerate()
        .filter_map(|(index, note)| {
            let document = &document_tokens[index];
            let mut score = 0.0;
            for query_token in &query_tokens {
                let term_frequency = document
                    .iter()
                    .filter(|token| *token == query_token)
                    .count() as f64;
                if term_frequency == 0.0 {
                    continue;
                }
                let document_frequency = document_tokens
                    .iter()
                    .filter(|tokens| tokens.iter().any(|token| token == query_token))
                    .count() as f64;
                let inverse_document_frequency =
                    ((notes.len() as f64 + 1.0) / (document_frequency + 1.0)).ln() + 1.0;
                score += term_frequency * inverse_document_frequency;
            }
            (score > 0.0).then(|| ProjectMemorySearchResult {
                id: note.metadata.id.clone(),
                title: note.metadata.title.clone(),
                relative_path: note.relative_path.clone(),
                excerpt: note.body.chars().take(MAX_SEARCH_EXCERPT).collect(),
                score,
                provenance_ids: note.metadata.provenance_ids.clone(),
            })
        })
        .collect::<Vec<_>>();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.title.cmp(&right.title))
    });
    results.truncate(MAX_SEARCH_RESULTS);
    Ok(results)
}

#[tauri::command]
pub fn list_project_memory(project_path: String) -> Result<ProjectMemorySnapshot, String> {
    list_project_memory_inner(&project_path)
}

#[tauri::command]
pub fn create_project_memory(
    project_path: String,
    input: CreateProjectMemoryInput,
) -> Result<ProjectMemoryNote, String> {
    create_project_memory_inner(&project_path, input)
}

#[tauri::command]
pub fn update_project_memory(
    project_path: String,
    input: UpdateProjectMemoryInput,
) -> Result<ProjectMemoryNote, String> {
    update_project_memory_inner(&project_path, input)
}

#[tauri::command]
pub fn archive_project_memory(
    project_path: String,
    id: String,
    expected_revision: String,
) -> Result<ProjectMemoryNote, String> {
    archive_project_memory_inner(&project_path, &id, &expected_revision)
}

#[tauri::command]
pub fn search_project_memory(
    project_path: String,
    query: String,
) -> Result<Vec<ProjectMemorySearchResult>, String> {
    search_project_memory_inner(&project_path, &query)
}

#[tauri::command]
pub fn watch_project_memory(
    app: tauri::AppHandle,
    state: State<'_, ProjectMemoryWatchState>,
    project_path: String,
) -> Result<(), String> {
    let root = memory_root(&project_path, true)?;
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "Project-memory watcher lock is poisoned".to_string())?;
    if watchers.contains_key(&root) {
        return Ok(());
    }
    let pending = Arc::new(AtomicBool::new(false));
    let callback_pending = pending.clone();
    let event_project_path = project_path.clone();
    let event_app = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_err() || callback_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = callback_pending.clone();
        let app = event_app.clone();
        let project_path = event_project_path.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(180)).await;
            pending.store(false, Ordering::SeqCst);
            let _ = app.emit(
                "project-memory:changed",
                ProjectMemoryChanged { project_path },
            );
        });
    })
    .map_err(|error| format!("Cannot create project-memory watcher: {error}"))?;
    watcher
        .watch(&root, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Cannot watch project memory: {error}"))?;
    watchers.insert(root, watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create(project: &TempDir, title: &str, body: &str) -> ProjectMemoryNote {
        create_project_memory_inner(
            project.path().to_str().unwrap(),
            CreateProjectMemoryInput {
                title: title.to_string(),
                body: body.to_string(),
                tags: vec!["test".to_string()],
                provenance_ids: vec!["prov-1".to_string()],
            },
        )
        .unwrap()
    }

    #[test]
    fn create_list_update_and_conflict_are_file_authoritative() {
        let project = TempDir::new().unwrap();
        let note = create(&project, "Architecture", "Uses [[Testing]].");
        assert_eq!(note.metadata.schema_version, 1);
        assert!(project.path().join(PROJECT_MEMORY_DIR).is_dir());

        let updated = update_project_memory_inner(
            project.path().to_str().unwrap(),
            UpdateProjectMemoryInput {
                id: note.metadata.id.clone(),
                expected_revision: note.revision.clone(),
                title: "Architecture".to_string(),
                body: "Updated body".to_string(),
                tags: vec![],
                provenance_ids: vec!["prov-1".to_string()],
            },
        )
        .unwrap();
        assert_ne!(updated.revision, note.revision);

        let stale = update_project_memory_inner(
            project.path().to_str().unwrap(),
            UpdateProjectMemoryInput {
                id: note.metadata.id,
                expected_revision: note.revision,
                title: "Stale".to_string(),
                body: "Would overwrite".to_string(),
                tags: vec![],
                provenance_ids: vec![],
            },
        );
        assert!(stale.unwrap_err().contains("conflict"));
    }

    #[test]
    fn graph_reports_backlinks_broken_links_orphans_cycles_and_duplicates() {
        let project = TempDir::new().unwrap();
        let first = create(&project, "First", "[[Second]] and [[Missing]]");
        let second = create(&project, "Second", "[[First]]");
        create(&project, "Orphan", "No links");
        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        let first = snapshot
            .notes
            .iter()
            .find(|note| note.metadata.id == first.metadata.id)
            .unwrap();
        let second = snapshot
            .notes
            .iter()
            .find(|note| note.metadata.id == second.metadata.id)
            .unwrap();
        assert_eq!(first.broken_links, vec!["Missing"]);
        assert_eq!(first.outbound_ids, vec![second.metadata.id.clone()]);
        assert_eq!(second.backlink_ids, vec![first.metadata.id.clone()]);
        assert!(snapshot.notes.iter().any(|note| note.orphaned));
    }

    #[test]
    fn search_is_ranked_bounded_and_preserves_provenance_ids() {
        let project = TempDir::new().unwrap();
        create(&project, "Database", "Postgres database migration database");
        create(&project, "UI", "React component");
        let results =
            search_project_memory_inner(project.path().to_str().unwrap(), "database").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Database");
        assert_eq!(results[0].provenance_ids, vec!["prov-1"]);
    }

    #[test]
    fn rejects_secrets_binary_and_oversized_content() {
        let project = TempDir::new().unwrap();
        assert!(create_project_memory_inner(
            project.path().to_str().unwrap(),
            CreateProjectMemoryInput {
                title: "Secret".to_string(),
                body: "api_key=abcdefghijklmnop".to_string(),
                tags: vec![],
                provenance_ids: vec![],
            },
        )
        .is_err());
        assert!(validate_content("Binary", "a\0b").is_err());
        assert!(validate_content("Large", &"x".repeat(MAX_PROJECT_MEMORY_NOTE_BYTES + 1)).is_err());
    }

    #[test]
    fn malformed_files_are_visible_warnings() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("broken.md"), "not frontmatter").unwrap();
        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.notes.is_empty());
        assert_eq!(snapshot.warnings[0].code, "malformed_frontmatter");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_note_is_rejected() {
        use std::os::unix::fs::symlink;
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        let outside = project.path().join("outside.md");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, root.join("link.md")).unwrap();
        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert_eq!(snapshot.warnings[0].code, "symlink_rejected");
    }
}
