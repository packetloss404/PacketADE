use super::shared::SKIP_DIRS;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tracing::info;

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

        let read_dir = fs::read_dir(path)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in read_dir.flatten() {
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
                Err(_) => continue,
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

        let read_dir = fs::read_dir(path)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        let mut dirs: Vec<String> = Vec::new();
        for entry in read_dir.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                        dirs.push(entry.path().to_string_lossy().to_string());
                    }
                }
            }
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

        let meta = fs::metadata(path)
            .map_err(|e| format!("Cannot read file metadata: {}", e))?;
        if meta.len() > MAX_EDITOR_FILE_SIZE {
            return Err(format!(
                "File too large for editor ({} bytes, limit {} bytes)",
                meta.len(),
                MAX_EDITOR_FILE_SIZE
            ));
        }

        fs::read_to_string(path)
            .map_err(|e| format!("Failed to read file: {}", e))
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
                return Err(format!("Parent directory does not exist: {}", parent.display()));
            }
        }

        fs::write(path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
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
