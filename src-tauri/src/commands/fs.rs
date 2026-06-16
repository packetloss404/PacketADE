use super::shared::SKIP_DIRS;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tracing::{info, warn};

#[derive(Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: Option<String>,
}

/// Filenames (case-sensitive) that should never appear in directory listings.
const SENSITIVE_NAMES: &[&str] = &["credentials.json", "service-account.json"];

/// File extensions whose contents are typically secret material.
const SENSITIVE_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore"];

#[tauri::command]
pub async fn get_cwd() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| format!("Failed to get current directory: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Cheap existence/type probe for a local path. Returns `true` only when the
/// path exists and is a directory. Used by bootstrap to reject a stale
/// persisted project path before it poisons PTY launches.
#[tauri::command]
pub async fn path_is_dir(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || Path::new(&path).is_dir())
        .await
        .map_err(|e| format!("Task join error: {}", e))
}

#[tauri::command]
pub async fn list_directory(dir_path: String, workspace: String) -> Result<Vec<DirEntry>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&dir_path)?;
        super::is_within_workspace(&dir_path, &workspace)?;
        info!(dir_path = %dir_path, "Listing directory");
        let path = Path::new(&dir_path);

        // Validate against symlink escape
        let canonical = fs::canonicalize(path)
            .map_err(|e| format!("Cannot resolve path '{}': {}", dir_path, e))?;
        if !canonical.is_dir() {
            return Err(format!("Resolved path is not a directory: {}", dir_path));
        }

        let mut entries: Vec<DirEntry> = Vec::new();

        let read_dir =
            fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry_result in read_dir {
            let entry = match entry_result {
                Ok(e) => e,
                Err(e) => {
                    warn!(
                        target: "packetade::fs::list_directory",
                        parent = %dir_path,
                        error = %e,
                        "skipping unreadable directory entry"
                    );
                    continue;
                }
            };
            let file_name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files/dirs (starting with .) except a few useful ones
            if file_name.starts_with('.')
                && !matches!(
                    file_name.as_str(),
                    ".gitignore" | ".eslintrc" | ".prettierrc"
                )
            {
                continue;
            }

            // Skip known sensitive filenames
            if SENSITIVE_NAMES.contains(&file_name.as_str()) {
                continue;
            }

            // Skip files with sensitive extensions
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                if SENSITIVE_EXTENSIONS.contains(&ext) {
                    continue;
                }
            }

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    warn!(
                        target: "packetade::fs::list_directory",
                        path = %entry.path().display(),
                        error = %e,
                        "skipping entry: failed to read metadata"
                    );
                    continue;
                }
            };

            let is_dir = metadata.is_dir();

            // Skip ignored directories
            if is_dir && SKIP_DIRS.contains(&file_name.as_str()) {
                continue;
            }

            let full_path = entry.path().to_string_lossy().to_string();
            let extension = if !is_dir {
                entry
                    .path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_string())
            } else {
                None
            };

            entries.push(DirEntry {
                name: file_name,
                path: full_path,
                is_dir,
                size: if is_dir { 0 } else { metadata.len() },
                extension,
            });
        }

        // Sort: directories first, then alphabetical
        entries.sort_by(|a, b| {
            if a.is_dir == b.is_dir {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            } else if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });

        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// List only immediate subdirectories of a given path.
/// Used by the "projects folder" setting to discover project folders.
/// No workspace constraint — the user explicitly configures this path.
#[tauri::command]
pub async fn list_subdirectories(dir_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&dir_path);
        if !path.is_absolute() {
            return Err(format!("Path must be absolute: {}", dir_path));
        }
        if !path.is_dir() {
            return Err(format!("Not a directory: {}", dir_path));
        }

        let read_dir =
            fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

        let mut dirs: Vec<String> = Vec::new();
        let mut skipped_count = 0usize;
        for entry_result in read_dir {
            let entry = match entry_result {
                Ok(e) => e,
                Err(_) => {
                    skipped_count += 1;
                    continue;
                }
            };
            match entry.metadata() {
                Ok(meta) => {
                    if meta.is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                            dirs.push(entry.path().to_string_lossy().to_string());
                        }
                    }
                }
                Err(e) => {
                    warn!(
                        target: "packetade::fs::list_subdirectories",
                        path = %entry.path().display(),
                        error = %e,
                        "skipping entry: failed to read metadata"
                    );
                }
            }
        }
        if skipped_count > 0 {
            warn!(
                target: "packetade::fs::list_subdirectories",
                parent = %dir_path,
                count = skipped_count,
                "skipped unreadable directory entries"
            );
        }
        dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        Ok(dirs)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Maximum file size for the text editor (2 MB).
const MAX_EDITOR_FILE_SIZE: u64 = 2_000_000;

#[tauri::command]
pub async fn read_file_contents(file_path: String, workspace: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        super::is_within_workspace(&file_path, &workspace)?;

        let path = Path::new(&file_path);
        if !path.is_file() {
            return Err(format!("Not a file: {}", file_path));
        }

        let meta = fs::metadata(path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
        if meta.len() > MAX_EDITOR_FILE_SIZE {
            return Err(format!(
                "File too large for editor ({} bytes, limit {} bytes)",
                meta.len(),
                MAX_EDITOR_FILE_SIZE
            ));
        }

        fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn write_file_contents(
    file_path: String,
    workspace: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        super::is_within_workspace(&file_path, &workspace)?;

        let path = Path::new(&file_path);

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                return Err(format!(
                    "Parent directory does not exist: {}",
                    parent.display()
                ));
            }
        }

        fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Directories excluded when enumerating project files for pickers/diffs.
const PROJECT_FILES_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
];

const PROJECT_FILES_DEFAULT_LIMIT: usize = 100;
const PROJECT_FILES_MAX_LIMIT: usize = 500;

/// Recursively walk a directory and collect project-relative file paths (forward slashes).
fn walk_collect(
    root: &Path,
    current: &Path,
    filter_lower: Option<&str>,
    limit: usize,
    out: &mut Vec<String>,
) {
    if out.len() >= limit {
        return;
    }
    let read_dir = match fs::read_dir(current) {
        Ok(rd) => rd,
        Err(e) => {
            warn!(
                target: "packetade::fs::walk_collect",
                path = %current.display(),
                error = %e,
                "skipping directory: failed to read_dir"
            );
            return;
        }
    };
    for entry_result in read_dir {
        if out.len() >= limit {
            return;
        }
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                warn!(
                    target: "packetade::fs::walk_collect",
                    parent = %current.display(),
                    error = %e,
                    "skipping unreadable directory entry"
                );
                continue;
            }
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    target: "packetade::fs::walk_collect",
                    path = %path.display(),
                    error = %e,
                    "skipping entry: failed to read metadata"
                );
                continue;
            }
        };
        if metadata.is_dir() {
            if PROJECT_FILES_SKIP_DIRS.contains(&file_name.as_str()) {
                continue;
            }
            walk_collect(root, &path, filter_lower, limit, out);
        } else if metadata.is_file() {
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(e) => {
                    warn!(
                        target: "packetade::fs::walk_collect",
                        path = %path.display(),
                        root = %root.display(),
                        error = %e,
                        "skipping file: path is not under root"
                    );
                    continue;
                }
            };
            if let Some(f) = filter_lower {
                if !rel.to_lowercase().contains(f) {
                    continue;
                }
            }
            out.push(rel);
        }
    }
}

/// List project files (relative paths, forward slashes) with optional
/// substring filter and cap. Used by the API-agent file picker / diff view.
#[tauri::command]
pub async fn list_project_files(
    project_path: String,
    filter: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;
        let root = Path::new(&project_path);
        let canonical_root = fs::canonicalize(root)
            .map_err(|e| format!("Cannot resolve project path '{}': {}", project_path, e))?;

        let effective_limit = limit
            .map(|l| l as usize)
            .unwrap_or(PROJECT_FILES_DEFAULT_LIMIT)
            .min(PROJECT_FILES_MAX_LIMIT)
            .max(1);

        let filter_lower = filter
            .as_deref()
            .map(|s| s.to_lowercase())
            .filter(|s| !s.is_empty());

        let mut out: Vec<String> = Vec::new();
        walk_collect(
            &canonical_root,
            &canonical_root,
            filter_lower.as_deref(),
            effective_limit,
            &mut out,
        );
        out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Read a project-relative file for display in a diff view.
///
/// Returns `Ok(Some(content))` on success, `Ok(None)` if the file does not
/// exist, and `Err(...)` for path-escape, canonicalization, or non-UTF8
/// failures.
#[tauri::command]
pub async fn read_file_for_diff(
    project_path: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        super::validate_project_path(&project_path)?;

        let root = Path::new(&project_path);
        let canonical_root = fs::canonicalize(root)
            .map_err(|e| format!("Cannot resolve project path '{}': {}", project_path, e))?;

        let rel = Path::new(&rel_path);
        if rel.is_absolute() {
            return Err(format!("rel_path must be relative: {}", rel_path));
        }

        let joined = canonical_root.join(rel);
        if !joined.exists() {
            return Ok(None);
        }

        let canonical_joined = fs::canonicalize(&joined)
            .map_err(|e| format!("Cannot resolve file '{}': {}", rel_path, e))?;
        if !canonical_joined.starts_with(&canonical_root) {
            return Err(format!("Path '{}' escapes project root", rel_path));
        }

        if !canonical_joined.is_file() {
            return Ok(None);
        }

        match fs::read_to_string(&canonical_joined) {
            Ok(content) => Ok(Some(content)),
            Err(e) => Err(format!("Failed to read file: {}", e)),
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_names_are_blocked() {
        for name in SENSITIVE_NAMES {
            assert!(
                SENSITIVE_NAMES.contains(name),
                "{} should be in the blocklist",
                name
            );
        }
        // Verify specific entries
        assert!(SENSITIVE_NAMES.contains(&"credentials.json"));
        assert!(SENSITIVE_NAMES.contains(&"service-account.json"));
    }

    #[test]
    fn sensitive_extensions_are_blocked() {
        assert!(SENSITIVE_EXTENSIONS.contains(&"pem"));
        assert!(SENSITIVE_EXTENSIONS.contains(&"key"));
        assert!(SENSITIVE_EXTENSIONS.contains(&"p12"));
        assert!(SENSITIVE_EXTENSIONS.contains(&"pfx"));
        assert!(SENSITIVE_EXTENSIONS.contains(&"keystore"));
    }

    #[test]
    fn non_sensitive_names_not_blocked() {
        assert!(!SENSITIVE_NAMES.contains(&"package.json"));
        assert!(!SENSITIVE_NAMES.contains(&"README.md"));
        assert!(!SENSITIVE_EXTENSIONS.contains(&"rs"));
        assert!(!SENSITIVE_EXTENSIONS.contains(&"ts"));
    }
}
