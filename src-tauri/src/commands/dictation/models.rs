use std::path::PathBuf;

use crate::core::brand::DATA_DIR_NAME;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Types shared with other dictation sub-modules
// ---------------------------------------------------------------------------

/// An audio input device descriptor (used by `audio.rs`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub index: u32,
    pub name: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

// ---------------------------------------------------------------------------
// Whisper model management
// ---------------------------------------------------------------------------

/// Information about a Whisper model available for download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperModelInfo {
    /// Model size identifier: "tiny", "base", "small", "medium", "large-v3"
    pub size: String,
    /// Whether the model file exists on disk
    pub downloaded: bool,
    /// Approximate file size in megabytes
    #[serde(rename = "fileSizeMb")]
    pub file_size_mb: u32,
    /// Full path to the model file (only set if downloaded)
    pub path: Option<String>,
}

/// Progress event payload emitted during model downloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelDownloadProgress {
    size: String,
    percent: u32,
}

/// All supported model sizes with their approximate file sizes in MB.
const MODEL_SIZES: &[(&str, u32)] = &[
    ("tiny", 75),
    ("base", 142),
    ("small", 466),
    ("medium", 1500),
    ("large-v3", 3000),
];

/// Returns the directory where Whisper models are stored: `~/.packetade/models/`
pub fn models_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(DATA_DIR_NAME).join("models"))
}

/// Returns the full path to a model file for the given size.
/// e.g. `~/.packetade/models/ggml-base.bin`
pub fn model_path(size: &str) -> Result<PathBuf, String> {
    Ok(models_dir()?.join(format!("ggml-{size}.bin")))
}

/// List all known Whisper models and their download status.
#[tauri::command]
pub fn list_whisper_models() -> Result<Vec<WhisperModelInfo>, String> {
    let mut models = Vec::with_capacity(MODEL_SIZES.len());

    for (size, file_size_mb) in MODEL_SIZES {
        let path = model_path(size)?;
        let downloaded = path.exists();
        models.push(WhisperModelInfo {
            size: size.to_string(),
            downloaded,
            file_size_mb: *file_size_mb,
            path: if downloaded {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            },
        });
    }

    Ok(models)
}

/// Download a Whisper model from HuggingFace.
///
/// Streams the download and emits `dictation:model-progress` events with
/// `{ size, percent }` payloads so the frontend can show a progress bar.
#[tauri::command]
pub async fn download_whisper_model(
    app_handle: tauri::AppHandle,
    size: String,
) -> Result<String, String> {
    // Validate the model size
    if !MODEL_SIZES.iter().any(|(s, _)| *s == size.as_str()) {
        return Err(format!(
            "Unknown model size '{}'. Valid sizes: {}",
            size,
            MODEL_SIZES
                .iter()
                .map(|(s, _)| *s)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    let dir = models_dir()?;
    let path = model_path(&size)?;

    // Check if already downloaded
    if path.exists() {
        info!("Model ggml-{}.bin already exists at {:?}", size, path);
        return Ok(path.to_string_lossy().to_string());
    }

    // Create the models directory if it doesn't exist
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create models directory {:?}: {}", dir, e))?;

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
        size
    );

    info!("Downloading Whisper model from {}", url);

    // Start the download
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to start download: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with HTTP {}: {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    if total_size == 0 {
        warn!("Server did not report content-length; progress will be estimated");
    }

    // Download to a temporary file first, then rename on success
    let temp_path = dir.join(format!("ggml-{}.bin.downloading", size));

    // Stream the response body to disk using chunk()
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut last_percent: u32 = 0;

    // Use reqwest's built-in chunk() method — no extra dependencies needed
    use tokio::io::AsyncWriteExt;

    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download error: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write chunk: {e}"))?;

        downloaded += chunk.len() as u64;

        // Emit progress events (only when percent changes to avoid spamming)
        let percent = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u32
        } else {
            // Estimate based on expected file size
            let expected = MODEL_SIZES
                .iter()
                .find(|(s, _)| *s == size.as_str())
                .map(|(_, mb)| *mb as u64 * 1024 * 1024)
                .unwrap_or(1);
            ((downloaded as f64 / expected as f64) * 100.0).min(99.0) as u32
        };

        if percent != last_percent {
            last_percent = percent;
            let _ = app_handle.emit(
                "dictation:model-progress",
                ModelDownloadProgress {
                    size: size.clone(),
                    percent,
                },
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {e}"))?;
    drop(file);

    // Rename temp file to final path
    tokio::fs::rename(&temp_path, &path)
        .await
        .map_err(|e| format!("Failed to finalize download: {e}"))?;

    // Emit 100% completion
    let _ = app_handle.emit(
        "dictation:model-progress",
        ModelDownloadProgress {
            size: size.clone(),
            percent: 100,
        },
    );

    info!(
        "Downloaded ggml-{}.bin ({} MB) to {:?}",
        size,
        downloaded / (1024 * 1024),
        path
    );

    Ok(path.to_string_lossy().to_string())
}

/// Delete a downloaded model file.
#[tauri::command]
pub fn delete_whisper_model(size: String) -> Result<(), String> {
    let path = model_path(&size)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete model file: {e}"))?;
        info!("Deleted model ggml-{}.bin", size);
    }
    Ok(())
}
