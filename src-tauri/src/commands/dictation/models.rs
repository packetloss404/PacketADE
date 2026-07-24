use std::path::PathBuf;

use crate::core::brand::DATA_DIR_NAME;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

struct ModelSpec {
    size: &'static str,
    file_size_mb: u32,
    sha256: &'static str,
}

/// Immutable upstream revision and SHA-256 values published by the official
/// ggerganov/whisper.cpp Hugging Face model repository.
const MODEL_REVISION: &str = "c521a4b02f422512d734391fdf08bb08c0862f68";
const MODEL_SPECS: &[ModelSpec] = &[
    ModelSpec {
        size: "tiny",
        file_size_mb: 75,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    },
    ModelSpec {
        size: "base",
        file_size_mb: 142,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelSpec {
        size: "small",
        file_size_mb: 466,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
    ModelSpec {
        size: "medium",
        file_size_mb: 1500,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    },
    ModelSpec {
        size: "large-v3",
        file_size_mb: 3000,
        sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    },
];

fn model_spec(size: &str) -> Option<&'static ModelSpec> {
    MODEL_SPECS.iter().find(|spec| spec.size == size)
}

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

fn checksum_marker_path(size: &str) -> Result<PathBuf, String> {
    Ok(models_dir()?.join(format!("ggml-{size}.bin.sha256")))
}

fn has_verified_marker(size: &str, expected: &str) -> bool {
    checksum_marker_path(size)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim().eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

/// Return a model only when it was installed through the verified download
/// path. Older unmarked files are revalidated the next time Download is used.
pub fn verified_model_path(size: &str) -> Result<PathBuf, String> {
    let spec = model_spec(size).ok_or_else(|| format!("Unknown model size '{}'", size))?;
    let path = model_path(size)?;
    if path.is_file() && has_verified_marker(size, spec.sha256) {
        Ok(path)
    } else {
        Err(format!(
            "Whisper model '{}' is missing or unverified; download it again in Dictation settings",
            size
        ))
    }
}

/// List all known Whisper models and their download status.
#[tauri::command]
pub fn list_whisper_models() -> Result<Vec<WhisperModelInfo>, String> {
    let mut models = Vec::with_capacity(MODEL_SPECS.len());

    for spec in MODEL_SPECS {
        let path = model_path(spec.size)?;
        let downloaded = path.is_file() && has_verified_marker(spec.size, spec.sha256);
        models.push(WhisperModelInfo {
            size: spec.size.to_string(),
            downloaded,
            file_size_mb: spec.file_size_mb,
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
    let spec = model_spec(&size).ok_or_else(|| {
        format!(
            "Unknown model size '{}'. Valid sizes: {}",
            size,
            MODEL_SPECS
                .iter()
                .map(|spec| spec.size)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;

    let dir = models_dir()?;
    let path = model_path(&size)?;

    // Existing files from older versions do not have a trust marker. Verify
    // them once rather than forcing a multi-gigabyte re-download.
    if path.exists() {
        if has_verified_marker(&size, spec.sha256)
            || verify_file_checksum(&path, spec.sha256).await?
        {
            write_checksum_marker(&size, spec.sha256).await?;
            info!("Verified existing model ggml-{}.bin at {:?}", size, path);
            return Ok(path.to_string_lossy().to_string());
        }
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("Failed to remove unverified model {:?}: {e}", path))?;
    }

    // Create the models directory if it doesn't exist
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create models directory {:?}: {}", dir, e))?;

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/{}/ggml-{}.bin",
        MODEL_REVISION, size
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
    let mut hasher = Sha256::new();

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
        hasher.update(&chunk);

        downloaded += chunk.len() as u64;

        // Emit progress events (only when percent changes to avoid spamming)
        let percent = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as u32
        } else {
            // Estimate based on expected file size
            let expected = spec.file_size_mb as u64 * 1024 * 1024;
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
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync file: {e}"))?;
    drop(file);

    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(spec.sha256) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!(
            "Whisper model checksum mismatch for '{}': expected {}, received {}",
            size, spec.sha256, actual_sha256
        ));
    }

    // Rename temp file to final path
    tokio::fs::rename(&temp_path, &path)
        .await
        .map_err(|e| format!("Failed to finalize download: {e}"))?;
    write_checksum_marker(&size, spec.sha256).await?;

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
    if let Ok(marker) = checksum_marker_path(&size) {
        if marker.exists() {
            std::fs::remove_file(&marker)
                .map_err(|e| format!("Failed to delete checksum marker: {e}"))?;
        }
    }
    Ok(())
}

async fn verify_file_checksum(path: &std::path::Path, expected: &str) -> Result<bool, String> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open model for checksum verification: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read model for checksum verification: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected))
}

async fn write_checksum_marker(size: &str, expected: &str) -> Result<(), String> {
    let marker = checksum_marker_path(size)?;
    let mut file = tokio::fs::File::create(&marker)
        .await
        .map_err(|e| format!("Failed to create checksum marker: {e}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(format!("{}\n", expected).as_bytes())
        .await
        .map_err(|e| format!("Failed to write checksum marker: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync checksum marker: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_model_specs_have_sha256_digests() {
        assert_eq!(MODEL_SPECS.len(), 5);
        for spec in MODEL_SPECS {
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn sha256_digest_comparison_rejects_modified_bytes() {
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let actual = format!("{:x}", Sha256::digest(b"abc"));
        let modified = format!("{:x}", Sha256::digest(b"abd"));
        assert_eq!(actual, expected);
        assert_ne!(modified, expected);
    }
}
