use crate::core::brand::DATA_DIR_NAME;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct CrashEntry {
    pub timestamp: String,
    pub path: String,
    pub summary: String,
}

fn crashes_dir() -> Result<PathBuf, String> {
    let home = dirs_home()?;
    Ok(home.join(DATA_DIR_NAME).join("crashes"))
}

fn dirs_home() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(up) = std::env::var("USERPROFILE") {
            return Ok(PathBuf::from(up));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        return Ok(PathBuf::from(h));
    }
    Err("Could not determine home directory".to_string())
}

fn validate_crash_path(path: &str) -> Result<PathBuf, String> {
    let dir = crashes_dir()?;
    let canonical_dir = std::fs::canonicalize(&dir)
        .map_err(|e| format!("Cannot resolve crashes dir: {}", e))?;
    let target = Path::new(path);
    let canonical_target = std::fs::canonicalize(target)
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    if !canonical_target.starts_with(&canonical_dir) {
        return Err("Path is outside the crashes directory".to_string());
    }
    Ok(canonical_target)
}

#[tauri::command]
pub fn list_crashes() -> Result<Vec<CrashEntry>, String> {
    let dir = crashes_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<CrashEntry> = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !file_name.starts_with("crash-") || !file_name.ends_with(".log") {
            continue;
        }
        let timestamp = file_name
            .trim_start_matches("crash-")
            .trim_end_matches(".log")
            .to_string();
        let summary = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| c.lines().next().map(|l| l.to_string()))
            .unwrap_or_else(|| "(empty)".to_string());
        entries.push(CrashEntry {
            timestamp,
            path: path.to_string_lossy().to_string(),
            summary,
        });
    }
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(entries)
}

#[tauri::command]
pub fn read_crash(path: String) -> Result<String, String> {
    let validated = validate_crash_path(&path)?;
    std::fs::read_to_string(&validated).map_err(|e| format!("Failed to read crash: {}", e))
}

#[tauri::command]
pub fn delete_crash(path: String) -> Result<(), String> {
    let validated = validate_crash_path(&path)?;
    std::fs::remove_file(&validated).map_err(|e| format!("Failed to delete crash: {}", e))
}

/// Installs a panic hook that writes crash info to ~/.packetade/crashes/crash-<timestamp>.log.
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_crash_log(info);
        default_hook(info);
    }));
}

fn write_crash_log(info: &std::panic::PanicHookInfo<'_>) -> Result<(), String> {
    let dir = crashes_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {}", e))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file = dir.join(format!("crash-{}.log", ts));

    let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "(non-string panic payload)".to_string()
    };

    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "(unknown location)".to_string());

    let backtrace = std::backtrace::Backtrace::force_capture();

    let contents = format!(
        "panic: {}\nlocation: {}\ntimestamp: {}\n\nbacktrace:\n{}\n",
        message, location, ts, backtrace
    );
    std::fs::write(&file, contents).map_err(|e| format!("write: {}", e))?;
    Ok(())
}
