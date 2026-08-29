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
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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

/// Suffix `write_atomic` uses for its crash-safety copy. Never has the `.md`
/// extension, so a leftover is not mistaken for a note by the directory scan.
const BACKUP_SUFFIX: &str = ".packetbench-backup";

/// Quiet period a filesystem burst must settle for before the watcher emits.
/// Real editors save with several syscalls (truncate, write, chmod, rename);
/// emitting on the first one has the frontend read a half-written file.
const WATCH_QUIET_PERIOD: Duration = Duration::from_millis(180);

/// Hard ceiling on how long a continuous storm may defer an emit. Without it a
/// process that touches the directory faster than `WATCH_QUIET_PERIOD` (a bulk
/// `git checkout`, a sync client) would starve live refresh forever.
const WATCH_MAX_DELAY: Duration = Duration::from_millis(1_500);

/// Distinct projects that may hold a live watcher at once. The UI tracks one
/// project at a time, but nothing stopped the map from accumulating one OS
/// watch handle (and its thread) for every project ever opened.
const MAX_PROJECT_MEMORY_WATCHERS: usize = 8;

/// Regexes are compiled once. `raw_links` used to build two `Regex` values per
/// note, i.e. 4,000 compilations for a full 2,000-note listing, which dominated
/// the cost of every watcher-triggered reload.
fn wiki_link_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\[\[([^\]\n]{1,200})\]\]").expect("valid wiki regex"))
}

fn markdown_link_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\[[^\]\n]*\]\(([^)\n]{1,240}\.md)(?:#[^)\n]*)?\)").expect("valid md regex")
    })
}

fn dash_run_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new("-+").expect("valid dash regex"))
}

fn secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}"#,
        )
        .expect("valid secret regex")
    })
}

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

struct ProjectMemoryWatch {
    /// The directory actually handed to `notify`. When `.agents/memory` does
    /// not exist yet this is the nearest existing ancestor, so the directory's
    /// creation still reaches the UI.
    watched: PathBuf,
    /// Monotonic arm counter, used to evict the least-recently-armed watcher.
    armed: u64,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
pub struct ProjectMemoryWatchState {
    /// Keyed by *project root*, not by watched directory. Keying by watched
    /// directory meant that once `.agents/memory` appeared, re-arming inserted
    /// a second entry and the ancestor watcher was never dropped.
    watchers: Mutex<HashMap<PathBuf, ProjectMemoryWatch>>,
    arm_counter: AtomicU64,
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
    secret_pattern().is_match(value)
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
    let collapsed = dash_run_pattern().replace_all(&value, "-").to_string();
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

/// Build a note from a Markdown file that carries no PacketBench frontmatter.
///
/// Identity comes from the file path (stable across edits), the title from the
/// first ATX heading or the file stem, and the timestamps from the filesystem.
/// Such a note is read-only in practice: an edit through the app rewrites it
/// with proper frontmatter, which is the intended upgrade path.
fn note_from_plain_markdown(
    normalized: &str,
    relative: &str,
    fs_metadata: &fs::Metadata,
    note_revision: String,
) -> ProjectMemoryNote {
    let stem = relative
        .rsplit('/')
        .next()
        .unwrap_or(relative)
        .trim_end_matches(".md")
        .to_string();

    let title = normalized
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| stem.clone());

    let millis = |time: std::io::Result<std::time::SystemTime>| -> u64 {
        time.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };
    let created_at = millis(fs_metadata.created());
    let updated_at = millis(fs_metadata.modified());

    ProjectMemoryNote {
        metadata: ProjectMemoryMetadata {
            schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
            // Path-derived so the id is stable without writing to the file.
            id: format!("md:{relative}"),
            title,
            created_at,
            updated_at: if updated_at == 0 { created_at } else { updated_at },
            archived: false,
            tags: vec!["unmanaged".to_string()],
            provenance_ids: Vec::new(),
        },
        body: normalized.trim_end().to_string(),
        revision: note_revision,
        relative_path: relative.to_string(),
        outbound_ids: Vec::new(),
        backlink_ids: Vec::new(),
        broken_links: Vec::new(),
        orphaned: false,
    }
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
    // A zero-byte `.md` is what a truncate-then-write editor leaves on disk for
    // the few milliseconds between opening the file and flushing the new text.
    // Turning that into a plain-Markdown note produced a ghost entry - a
    // titled, selectable, empty note that replaced the real one in the list and
    // stole the pane's selection. Report it instead; the next scan clears it.
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Err(ProjectMemoryWarning {
            relative_path: relative,
            code: "empty".to_string(),
            message: "File is empty - it may be mid-save by another editor".to_string(),
        });
    }
    // Hash before the move: `revision` needs the bytes and `String::from_utf8`
    // consumes them. The old code cloned the whole file to satisfy both, which
    // doubled peak memory on a listing of large notes.
    let note_revision = revision(&raw);
    let text = String::from_utf8(raw).map_err(|_| ProjectMemoryWarning {
        relative_path: relative.clone(),
        code: "invalid_utf8".to_string(),
        message: "Note is not valid UTF-8".to_string(),
    })?;
    // Windows editors (Notepad, VS Code with `files.encoding: utf8bom`, several
    // PowerShell redirects) prepend a BOM. Without stripping it the `---\n`
    // prefix test failed, so a fully managed note silently degraded to an
    // unmanaged `md:` note: its real id vanished and updates by id stopped
    // resolving.
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let normalized = text.replace("\r\n", "\n");
    // A plain Markdown file with no frontmatter is a legitimate note. Users and
    // agents naturally drop `.md` files into `.agents/memory`; rejecting those as
    // `malformed_frontmatter` meant the pane raised a warning instead of showing
    // the content the user had just written. Derive metadata from the file.
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return Ok(note_from_plain_markdown(
            &normalized,
            &relative,
            &metadata,
            note_revision,
        ));
    };
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
        revision: note_revision,
        relative_path: relative,
        outbound_ids: Vec::new(),
        backlink_ids: Vec::new(),
        broken_links: Vec::new(),
        orphaned: false,
    })
}

fn raw_links(body: &str) -> Vec<String> {
    let wiki = wiki_link_pattern();
    let markdown = markdown_link_pattern();
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
        let file_name = entry.file_name().to_string_lossy().to_string();
        // A crash (or a kill) between the backup copy and the rename in
        // `write_atomic` leaves the note's content only in the backup. Nothing
        // ever reclaimed it, so the note looked permanently lost. Surface it as
        // a named warning; the bytes are still on disk under this path.
        if let Some(stem) = file_name.strip_suffix(BACKUP_SUFFIX) {
            if !root.join(stem).exists() {
                warnings.push(ProjectMemoryWarning {
                    relative_path: file_name.clone(),
                    code: "orphaned_backup".to_string(),
                    message: format!(
                        "PacketBench was interrupted while saving {stem}. Its previous content is preserved in this file - rename it back to {stem} to recover."
                    ),
                });
            }
            continue;
        }
        // Editor lock and auto-save files keep the `.md` extension while being
        // dot-prefixed (Emacs `.#note.md`, `.note.md`). They are never notes,
        // and on Unix they are dangling symlinks, so each one raised a bogus
        // `symlink_rejected` warning for the whole time an editor was open.
        if file_name.starts_with('.') {
            continue;
        }
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
    // Rename over the destination first. `std::fs::rename` replaces an existing
    // file atomically on both POSIX and Windows (`MOVEFILE_REPLACE_EXISTING`),
    // so a reader - our own watcher-driven rescan included - sees either the old
    // note or the new one, never a gap.
    //
    // The previous code unconditionally did copy-to-backup, `remove_file`, then
    // persist. That opened a window in which the note did not exist at all: a
    // watcher event landing inside it listed the note as deleted, and a crash
    // inside it left the content only in a `.packetbench-backup` file that
    // nothing ever read back.
    let (temp, rename_error) = match temp.persist(path) {
        Ok(_) => return Ok(()),
        Err(error) => (error.file, error.error),
    };
    // Replace-in-place failed (read-only attribute, a Windows share-mode lock
    // from an open editor, a cross-device temp dir). Fall back to the
    // remove-then-rename dance, keeping a backup so the interruption is
    // recoverable and visible to the next listing.
    if !path.exists() {
        // Nothing to displace, so the fallback cannot help: report the real
        // cause rather than a second, less informative failure.
        return Err(format!(
            "Cannot persist project-memory note: {rename_error}"
        ));
    }
    let backup = PathBuf::from(format!("{}{}", path.display(), BACKUP_SUFFIX));
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
    Ok(())
}

fn find_note(project_path: &str, id: &str) -> Result<ProjectMemoryNote, String> {
    list_project_memory_inner(project_path)?
        .notes
        .into_iter()
        .find(|note| note.metadata.id == id)
        // Renamed or deleted while the pane had it open is the common cause, and
        // the bare "was not found" gave the user nothing to act on.
        .ok_or_else(|| {
            "Project-memory note was not found. It may have been renamed or deleted outside PacketBench."
                .to_string()
        })
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
    // Count each note's tokens once. The old shape scored by walking the token
    // vector for every query term, and recomputed document frequency by
    // re-scanning *every* document inside that loop - O(notes^2 x tokens per
    // note x query terms). At the 2,000-note ceiling with large notes that is
    // billions of comparisons on the UI's command thread, i.e. a hang.
    // It also built a `format!("{title} {body}")` copy of every note, doubling
    // peak memory over an already fully-loaded snapshot.
    let query_set: HashSet<&String> = query_tokens.iter().collect();
    let document_counts = notes
        .iter()
        .map(|note| {
            let mut counts: HashMap<String, f64> = HashMap::new();
            for token in tokens(&note.metadata.title)
                .into_iter()
                .chain(tokens(&note.body))
            {
                // Only query terms can contribute to the score, so the per-note
                // map stays bounded by the query length rather than the note.
                if query_set.contains(&token) {
                    *counts.entry(token).or_insert(0.0) += 1.0;
                }
            }
            counts
        })
        .collect::<Vec<_>>();
    let document_frequency = |token: &String| -> f64 {
        document_counts
            .iter()
            .filter(|counts| counts.contains_key(token))
            .count() as f64
    };
    let frequencies = query_tokens
        .iter()
        .map(|token| (token.clone(), document_frequency(token)))
        .collect::<HashMap<_, _>>();
    let mut results = notes
        .iter()
        .enumerate()
        .filter_map(|(index, note)| {
            let document = &document_counts[index];
            let mut score = 0.0;
            for query_token in &query_tokens {
                let term_frequency = document.get(query_token).copied().unwrap_or(0.0);
                if term_frequency == 0.0 {
                    continue;
                }
                let document_frequency =
                    frequencies.get(query_token).copied().unwrap_or_default();
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

/// Wait until the filesystem burst tracked by `sequence` has been quiet for
/// `quiet`, or until `max` has elapsed since the first event of the burst.
///
/// Extracted so the coalescing rule is unit-testable: the watcher callback that
/// drives it needs a live Tauri `AppHandle` and cannot be exercised in tests.
async fn settle_watch_burst(sequence: &AtomicU64, quiet: Duration, max: Duration) {
    let deadline = Instant::now() + max;
    loop {
        let before = sequence.load(Ordering::SeqCst);
        tokio::time::sleep(quiet).await;
        if sequence.load(Ordering::SeqCst) == before || Instant::now() >= deadline {
            return;
        }
    }
}

/// Directory to hand `notify` for a project.
///
/// `.agents/memory` when it exists; otherwise the nearest existing ancestor
/// inside the project, so that the directory being created by an agent or by
/// the user's first note still produces an event.
///
/// This deliberately does **not** create the directory. Arming the watcher used
/// to `mkdir -p .agents/memory`, so merely opening the Memory pane wrote a new
/// untracked directory into every repository PacketBench touched - visible in
/// `git status`, and a fresh nag in any project that had not chosen to keep
/// project memory. The directory is now created only by an actual note write.
///
/// The ancestor fallback is deliberately cheap rather than precise: unrelated
/// churn at that level does emit, but a listing of a directory that does not
/// exist is a single `stat` returning the empty snapshot, and the debounce caps
/// it at one emit per settled burst.
fn watch_target(project_path: &str) -> Result<PathBuf, String> {
    let root = memory_root(project_path, false)?;
    if root.is_dir() {
        return Ok(root);
    }
    let project = project_root(project_path)?;
    let mut candidate = root.as_path();
    while let Some(parent) = candidate.parent() {
        if parent.is_dir() && parent.starts_with(&project) {
            return Ok(parent.to_path_buf());
        }
        candidate = parent;
    }
    Ok(project)
}

#[tauri::command]
pub fn watch_project_memory(
    app: tauri::AppHandle,
    state: State<'_, ProjectMemoryWatchState>,
    project_path: String,
) -> Result<(), String> {
    let project = project_root(&project_path)?;
    let target = watch_target(&project_path)?;
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "Project-memory watcher lock is poisoned".to_string())?;
    let armed = state.arm_counter.fetch_add(1, Ordering::Relaxed);
    if let Some(existing) = watchers.get_mut(&project) {
        if existing.watched == target {
            existing.armed = armed;
            return Ok(());
        }
        // The memory directory appeared (or vanished): drop the stale watcher
        // before installing the replacement so the handle is not leaked.
        watchers.remove(&project);
    }

    // Trailing-edge debounce. `pending` gates a single timer task per burst and
    // `sequence` is bumped by every event, so the task extends its own wait
    // while the storm continues and fires once, `WATCH_QUIET_PERIOD` after the
    // last event. The previous fixed-delay-from-the-first-event shape emitted
    // ~180ms into a save - reliably mid-write for a truncate-then-write editor -
    // and then re-armed for every subsequent 180ms slice of a bulk checkout,
    // making the frontend re-list the whole directory several times a second.
    let pending = Arc::new(AtomicBool::new(false));
    let sequence = Arc::new(AtomicU64::new(0));
    let callback_pending = pending.clone();
    let callback_sequence = sequence.clone();
    let event_project_path = project_path.clone();
    let event_app = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_err() {
            return;
        }
        // Always record the event; only the first of a burst spawns a timer.
        // Every later event costs one atomic increment instead of a task.
        callback_sequence.fetch_add(1, Ordering::SeqCst);
        if callback_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = callback_pending.clone();
        let sequence = callback_sequence.clone();
        let app = event_app.clone();
        let project_path = event_project_path.clone();
        tauri::async_runtime::spawn(async move {
            settle_watch_burst(&sequence, WATCH_QUIET_PERIOD, WATCH_MAX_DELAY).await;
            // Re-arm before emitting: an event racing the emit then schedules a
            // fresh timer instead of being dropped, which is what made a save
            // landing exactly on the boundary go unnoticed.
            pending.store(false, Ordering::SeqCst);
            let _ = app.emit(
                "project-memory:changed",
                ProjectMemoryChanged { project_path },
            );
        });
    })
    .map_err(|error| format!("Cannot create project-memory watcher: {error}"))?;
    watcher
        .watch(&target, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Cannot watch project memory: {error}"))?;

    // Bound the table. Every entry holds an OS watch handle (and, on Linux, an
    // inotify instance); switching between many projects used to accumulate one
    // per project for the lifetime of the app.
    while watchers.len() >= MAX_PROJECT_MEMORY_WATCHERS {
        let Some(oldest) = watchers
            .iter()
            .min_by_key(|(_, watch)| watch.armed)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        watchers.remove(&oldest);
    }
    watchers.insert(
        project,
        ProjectMemoryWatch {
            watched: target,
            armed,
            _watcher: watcher,
        },
    );
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
    fn plain_markdown_without_frontmatter_is_listed_as_a_note() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("architecture.md"),
            "# House rules\n\nNever hardcode the brand string.\n",
        )
        .unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();

        // Hand-authored Markdown used to land in `warnings` as
        // `malformed_frontmatter` and never appear as a note.
        assert!(
            snapshot.warnings.is_empty(),
            "unexpected warnings: {:?}",
            snapshot.warnings
        );
        assert_eq!(snapshot.notes.len(), 1);
        let note = &snapshot.notes[0];
        assert_eq!(note.metadata.title, "House rules");
        assert_eq!(note.metadata.id, "md:architecture.md");
        assert!(note.body.contains("Never hardcode the brand string."));
    }

    #[test]
    fn plain_markdown_falls_back_to_the_filename_for_a_title() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("no-heading.md"), "just a body, no heading\n").unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert_eq!(snapshot.notes.len(), 1);
        assert_eq!(snapshot.notes[0].metadata.title, "no-heading");
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
        // Frontmatter that is *started* and then broken is a real authoring
        // error and must stay visible. (A file with no frontmatter at all is a
        // valid plain-Markdown note - see the plain_markdown_* tests.)
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("broken.md"), "---\ntitle: [unterminated\n").unwrap();
        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.notes.is_empty());
        assert_eq!(snapshot.warnings[0].code, "malformed_frontmatter");
    }

    // ---------------------------------------------------------------
    // Interoperability with real editors, crashes, and bulk operations.
    // ---------------------------------------------------------------

    /// FAULT: a truncate-then-write editor leaves the file zero-length for a
    /// few milliseconds. `parse_note` treated that as valid plain Markdown and
    /// produced a titled, empty "ghost" note that replaced the real one in the
    /// list (and stole the pane's selection when the real note came back).
    #[test]
    fn an_empty_file_is_a_warning_not_a_ghost_note() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("mid-save.md"), "").unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.notes.is_empty(), "ghost note: {:?}", snapshot.notes);
        assert_eq!(snapshot.warnings.len(), 1);
        assert_eq!(snapshot.warnings[0].code, "empty");
    }

    /// FAULT: same window, but for an editor that writes the frontmatter first.
    /// The partial file must warn rather than list, and the completed file must
    /// then list cleanly - i.e. the transient state is not sticky.
    #[test]
    fn a_partially_written_note_warns_then_recovers_when_the_write_completes() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("half.md");
        fs::write(&path, "---\nschemaVersion: 1\nid: abc\ntitle: Half").unwrap();

        let mid = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(mid.notes.is_empty());
        assert_eq!(mid.warnings[0].code, "malformed_frontmatter");

        let metadata = ProjectMemoryMetadata {
            schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
            id: "abc".to_string(),
            title: "Half".to_string(),
            created_at: 1,
            updated_at: 2,
            archived: false,
            tags: vec![],
            provenance_ids: vec![],
        };
        fs::write(&path, render_note(&metadata, "Body").unwrap()).unwrap();

        let done = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(done.warnings.is_empty(), "{:?}", done.warnings);
        assert_eq!(done.notes.len(), 1);
        assert_eq!(done.notes[0].metadata.id, "abc");
    }

    /// FAULT: Windows editors write a UTF-8 BOM. The BOM defeated the `---`
    /// frontmatter test, so a fully managed note silently degraded to an
    /// unmanaged `md:` note - losing its id, so updates by id stopped resolving.
    #[test]
    fn a_bom_prefixed_note_keeps_its_frontmatter_identity() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        let metadata = ProjectMemoryMetadata {
            schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
            id: "bom-id".to_string(),
            title: "Saved by Notepad".to_string(),
            created_at: 1,
            updated_at: 2,
            archived: false,
            tags: vec![],
            provenance_ids: vec![],
        };
        let rendered = render_note(&metadata, "Body").unwrap();
        fs::write(root.join("bom.md"), format!("\u{feff}{rendered}")).unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
        assert_eq!(snapshot.notes.len(), 1);
        assert_eq!(snapshot.notes[0].metadata.id, "bom-id");
        assert_eq!(snapshot.notes[0].metadata.title, "Saved by Notepad");
    }

    /// CRLF notes are the norm on Windows and must parse identically.
    #[test]
    fn a_crlf_note_parses_the_same_as_its_lf_twin() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("crlf.md"), "# Windows note\r\n\r\nBody line.\r\n").unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
        assert_eq!(snapshot.notes[0].metadata.title, "Windows note");
    }

    /// FAULT: editor lock/auto-save files keep the `.md` extension while being
    /// dot-prefixed (Emacs `.#note.md`). Each one raised a warning - on Unix a
    /// `symlink_rejected` - for the entire time the editor had the file open.
    #[test]
    fn editor_lock_and_autosave_files_are_ignored() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("real.md"), "# Real\n\nBody\n").unwrap();
        fs::write(root.join(".#real.md"), "user@host.12345").unwrap();
        fs::write(root.join(".real.md.swp"), "vim swap").unwrap();
        fs::write(root.join("real.md~"), "emacs backup").unwrap();
        fs::write(root.join("4913"), "vim probe").unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
        assert_eq!(snapshot.notes.len(), 1);
        assert_eq!(snapshot.notes[0].metadata.title, "Real");
    }

    /// FAULT: `write_atomic` used to delete the note before renaming the temp
    /// file into place, so a concurrent read (our own watcher rescan included)
    /// could observe the note as missing. The replacement path renames straight
    /// over the destination and must leave no backup residue behind.
    #[test]
    fn updating_a_note_never_removes_the_file_and_leaves_no_backup() {
        let project = TempDir::new().unwrap();
        let note = create(&project, "Atomic", "First body");
        let root = project.path().join(PROJECT_MEMORY_DIR);
        let path = root.join(&note.relative_path);
        assert!(path.is_file());

        update_project_memory_inner(
            project.path().to_str().unwrap(),
            UpdateProjectMemoryInput {
                id: note.metadata.id.clone(),
                expected_revision: note.revision.clone(),
                title: "Atomic".to_string(),
                body: "Second body".to_string(),
                tags: vec![],
                provenance_ids: vec![],
            },
        )
        .unwrap();

        assert!(path.is_file(), "note vanished across an update");
        assert!(fs::read_to_string(&path).unwrap().contains("Second body"));
        let residue = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(BACKUP_SUFFIX))
            .collect::<Vec<_>>();
        assert!(residue.is_empty(), "backup residue: {residue:?}");
    }

    /// FAULT: a crash (or a kill) between the backup copy and the rename left
    /// the note's only surviving content in a `.packetbench-backup` file that
    /// nothing ever read back - the note simply looked deleted after restart.
    #[test]
    fn a_backup_orphaned_by_a_crash_is_reported_with_recovery_guidance() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(format!("lost.md{BACKUP_SUFFIX}")),
            "# Lost\n\nThe only copy.\n",
        )
        .unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.notes.is_empty());
        assert_eq!(snapshot.warnings.len(), 1);
        assert_eq!(snapshot.warnings[0].code, "orphaned_backup");
        assert!(snapshot.warnings[0].message.contains("lost.md"));
    }

    /// A backup whose note is present again is settled business - stay quiet.
    #[test]
    fn a_backup_next_to_its_restored_note_is_not_reported() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("kept.md"), "# Kept\n\nBody\n").unwrap();
        fs::write(root.join(format!("kept.md{BACKUP_SUFFIX}")), "old").unwrap();

        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.warnings.is_empty(), "{:?}", snapshot.warnings);
        assert_eq!(snapshot.notes.len(), 1);
    }

    /// HARD CONSTRAINT: PacketBench must never write to or modify `.gitignore`.
    /// Exercised across the whole mutating surface, with the file present.
    #[test]
    fn no_project_memory_operation_ever_touches_gitignore() {
        let project = TempDir::new().unwrap();
        let gitignore = project.path().join(".gitignore");
        let original = "node_modules/\ntarget/\n";
        fs::write(&gitignore, original).unwrap();

        let note = create(&project, "Interop", "Body with [[Nothing]]");
        let path = project.path().to_str().unwrap();
        update_project_memory_inner(
            path,
            UpdateProjectMemoryInput {
                id: note.metadata.id.clone(),
                expected_revision: note.revision.clone(),
                title: "Interop".to_string(),
                body: "Changed".to_string(),
                tags: vec![],
                provenance_ids: vec![],
            },
        )
        .unwrap();
        let refreshed = find_note(path, &note.metadata.id).unwrap();
        archive_project_memory_inner(path, &note.metadata.id, &refreshed.revision).unwrap();
        list_project_memory_inner(path).unwrap();
        search_project_memory_inner(path, "changed").unwrap();

        assert_eq!(fs::read_to_string(&gitignore).unwrap(), original);
    }

    /// HARD CONSTRAINT, absent-file half: we must not *create* one either.
    #[test]
    fn project_memory_never_creates_a_gitignore() {
        let project = TempDir::new().unwrap();
        create(&project, "Interop", "Body");
        assert!(
            !project.path().join(".gitignore").exists(),
            "PacketBench created a .gitignore"
        );
    }

    /// MATRIX: `.agents/` listed in `.gitignore` changes nothing - notes still
    /// list, and we still do not rewrite the ignore file to "fix" it.
    #[test]
    fn a_gitignored_agents_directory_still_reads_and_writes_normally() {
        let project = TempDir::new().unwrap();
        let gitignore = project.path().join(".gitignore");
        let original = ".agents/\n";
        fs::write(&gitignore, original).unwrap();

        let note = create(&project, "Ignored but present", "Body");
        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert_eq!(snapshot.notes.len(), 1);
        assert_eq!(snapshot.notes[0].metadata.id, note.metadata.id);
        assert_eq!(fs::read_to_string(&gitignore).unwrap(), original);
    }

    /// MATRIX: an empty project (no `.agents/` at all) is a clean empty
    /// snapshot, not an error, and reading it must not create the directory.
    #[test]
    fn an_empty_project_lists_cleanly_without_creating_anything() {
        let project = TempDir::new().unwrap();
        let snapshot = list_project_memory_inner(project.path().to_str().unwrap()).unwrap();
        assert!(snapshot.notes.is_empty());
        assert!(snapshot.warnings.is_empty());
        assert!(
            !project.path().join(".agents").exists(),
            "listing created .agents"
        );
    }

    /// FAULT: arming the watcher ran `mkdir -p .agents/memory`, so merely
    /// opening the Memory pane wrote a new untracked directory into every
    /// repository PacketBench touched. Resolving the watch target must be
    /// read-only, and must fall back to an existing ancestor so that the
    /// directory appearing later still produces an event.
    #[test]
    fn resolving_a_watch_target_never_creates_the_memory_directory() {
        let project = TempDir::new().unwrap();
        let target = watch_target(project.path().to_str().unwrap()).unwrap();
        assert!(
            !project.path().join(".agents").exists(),
            "arming the watcher created .agents"
        );
        assert_eq!(target, fs::canonicalize(project.path()).unwrap());

        fs::create_dir_all(project.path().join(PROJECT_MEMORY_DIR)).unwrap();
        let target = watch_target(project.path().to_str().unwrap()).unwrap();
        assert_eq!(
            target,
            fs::canonicalize(project.path().join(PROJECT_MEMORY_DIR)).unwrap()
        );
    }

    /// FAULT: the watcher fired a fixed 180ms after the *first* event of a
    /// burst, which for a truncate-then-write editor is reliably mid-save. The
    /// debounce is now trailing: it settles only after the burst goes quiet.
    #[tokio::test]
    async fn a_watch_burst_settles_only_after_the_last_event() {
        let sequence = Arc::new(AtomicU64::new(1));
        let storm = sequence.clone();
        let feeder = tokio::spawn(async move {
            // Five events, 20ms apart - the shape of one editor save.
            for _ in 0..5 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                storm.fetch_add(1, Ordering::SeqCst);
            }
        });

        let started = Instant::now();
        settle_watch_burst(
            &sequence,
            Duration::from_millis(60),
            Duration::from_millis(5_000),
        )
        .await;
        let elapsed = started.elapsed();
        feeder.await.unwrap();

        // The last event lands ~100ms in; a trailing debounce cannot return
        // before that plus the quiet period. A leading-edge debounce would have
        // returned at ~60ms, mid-burst.
        assert!(
            elapsed >= Duration::from_millis(150),
            "settled mid-burst after {elapsed:?}"
        );
    }

    /// FAULT (the other side of the same coin): a process that touches the
    /// directory faster than the quiet period must not starve live refresh
    /// forever. The max-delay ceiling forces an emit.
    #[tokio::test]
    async fn a_continuous_storm_still_refreshes_within_the_ceiling() {
        let sequence = Arc::new(AtomicU64::new(1));
        let storm = sequence.clone();
        let running = Arc::new(AtomicBool::new(true));
        let stop = running.clone();
        let feeder = tokio::spawn(async move {
            while stop.load(Ordering::SeqCst) {
                storm.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });

        let started = Instant::now();
        settle_watch_burst(
            &sequence,
            Duration::from_millis(50),
            Duration::from_millis(300),
        )
        .await;
        let elapsed = started.elapsed();
        running.store(false, Ordering::SeqCst);
        feeder.await.unwrap();

        assert!(
            elapsed < Duration::from_millis(2_000),
            "never settled under a continuous storm ({elapsed:?})"
        );
    }

    /// FAULT: search recomputed document frequency by re-scanning every
    /// document inside the per-note, per-term scoring loop. That is
    /// O(notes^2 x tokens x terms) - at the 2,000-note ceiling it hangs the
    /// command thread. The bound below is deliberately loose; the old shape
    /// took orders of magnitude longer on this corpus.
    #[test]
    fn search_over_a_large_corpus_stays_bounded_and_ranked() {
        let project = TempDir::new().unwrap();
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::create_dir_all(&root).unwrap();
        let filler = "alpha beta gamma delta epsilon zeta eta theta ".repeat(60);
        for index in 0..600 {
            let metadata = ProjectMemoryMetadata {
                schema_version: PROJECT_MEMORY_SCHEMA_VERSION,
                id: format!("bulk-{index}"),
                title: format!("Bulk note {index}"),
                created_at: index as u64,
                updated_at: index as u64,
                archived: false,
                tags: vec![],
                provenance_ids: vec![],
            };
            let body = if index == 7 {
                format!("{filler} needle needle needle")
            } else {
                filler.clone()
            };
            fs::write(
                root.join(format!("bulk-{index}.md")),
                render_note(&metadata, &body).unwrap(),
            )
            .unwrap();
        }

        let started = Instant::now();
        let results = search_project_memory_inner(
            project.path().to_str().unwrap(),
            "needle alpha beta gamma delta",
        )
        .unwrap();
        let elapsed = started.elapsed();

        assert_eq!(results.len(), MAX_SEARCH_RESULTS);
        assert_eq!(results[0].id, "bulk-7");
        assert!(
            elapsed < Duration::from_secs(60),
            "search took {elapsed:?} - the quadratic scoring loop is back"
        );
    }

    /// FAULT: a note renamed or deleted outside PacketBench while the pane had
    /// it open produced a bare "was not found", which told the user nothing.
    #[test]
    fn a_note_deleted_outside_packetbench_fails_with_actionable_guidance() {
        let project = TempDir::new().unwrap();
        let note = create(&project, "Doomed", "Body");
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::remove_file(root.join(&note.relative_path)).unwrap();

        let error = update_project_memory_inner(
            project.path().to_str().unwrap(),
            UpdateProjectMemoryInput {
                id: note.metadata.id,
                expected_revision: note.revision,
                title: "Doomed".to_string(),
                body: "Body".to_string(),
                tags: vec![],
                provenance_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("renamed or deleted"), "{error}");
    }

    /// A managed note whose *file* was renamed keeps its frontmatter id, so an
    /// in-flight update still resolves and writes to the new path.
    #[test]
    fn a_managed_note_survives_a_file_rename_because_identity_lives_in_the_file() {
        let project = TempDir::new().unwrap();
        let note = create(&project, "Renamed", "Body");
        let root = project.path().join(PROJECT_MEMORY_DIR);
        fs::rename(
            root.join(&note.relative_path),
            root.join("moved-by-the-user.md"),
        )
        .unwrap();

        let found = find_note(project.path().to_str().unwrap(), &note.metadata.id).unwrap();
        assert_eq!(found.relative_path, "moved-by-the-user.md");
        update_project_memory_inner(
            project.path().to_str().unwrap(),
            UpdateProjectMemoryInput {
                id: note.metadata.id.clone(),
                expected_revision: found.revision,
                title: "Renamed".to_string(),
                body: "Updated after rename".to_string(),
                tags: vec![],
                provenance_ids: vec![],
            },
        )
        .unwrap();
        assert!(fs::read_to_string(root.join("moved-by-the-user.md"))
            .unwrap()
            .contains("Updated after rename"));
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
