use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

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
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub index: u32,
    /// CPAL's host-qualified stable identifier. Device indexes are retained
    /// only to migrate configurations written before v0.10.3.
    pub id: Option<String>,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub sample_format: Option<String>,
}

/// Result returned by the microphone doctor. It contains signal statistics
/// only; no captured samples or transcript leave the command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceTestResult {
    pub device_id: Option<String>,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    pub captured_frames: u64,
    pub duration_ms: u64,
    pub peak_level: f32,
    pub rms_level: f32,
    pub warning: Option<String>,
}

/// Private, transcript-free performance and capture metadata returned with a
/// successful transcription.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationResult {
    pub text: String,
    pub duration_seconds: Option<f64>,
    pub input_sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    pub device_name: String,
    pub device_id: Option<String>,
    pub model_size: String,
    pub detected_language: Option<String>,
    pub model_load_ms: u64,
    pub inference_ms: u64,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Whisper model management
// ---------------------------------------------------------------------------

/// Information about a Whisper model available for download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperModelInfo {
    /// Model size identifier: "tiny", "base", "small", "medium", "large-v3"
    pub size: String,
    /// Whether the model file is verified and ready for transcription.
    pub downloaded: bool,
    /// Whether a model file exists but may still need checksum verification.
    pub installed: bool,
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

/// Returns the directory where Whisper models are stored: `~/.packetbench/models/`
pub fn models_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(DATA_DIR_NAME).join("models"))
}

/// Returns the full path to a model file for the given size.
/// e.g. `~/.packetbench/models/ggml-base.bin`
pub fn model_path(size: &str) -> Result<PathBuf, String> {
    Ok(models_dir()?.join(format!("ggml-{size}.bin")))
}

fn checksum_marker_path(size: &str) -> Result<PathBuf, String> {
    Ok(models_dir()?.join(format!("ggml-{size}.bin.sha256")))
}

/// Marker format is `<sha256> <byte-length>`. Markers written before the length
/// was recorded contain the digest alone and are still accepted.
fn parse_checksum_marker(contents: &str) -> Option<(String, Option<u64>)> {
    let mut fields = contents.split_whitespace();
    let digest = fields.next()?.to_string();
    let length = fields.next().and_then(|value| value.parse::<u64>().ok());
    Some((digest, length))
}

/// A model counts as verified only when the recorded digest matches *and* the
/// file is still the length it was when we hashed it.
///
/// Failure mode this guards: a model truncated *after* verification (a
/// disk-full copy, an interrupted sync, a half-restored backup) kept its marker
/// and was loaded as trusted. The length check turns that into an actionable
/// "download it again" instead of an opaque whisper.cpp load failure.
fn has_verified_marker(size: &str, expected: &str) -> bool {
    let Ok(marker_path) = checksum_marker_path(size) else {
        return false;
    };
    let Ok(contents) = std::fs::read_to_string(marker_path) else {
        return false;
    };
    let Some((digest, recorded_len)) = parse_checksum_marker(&contents) else {
        return false;
    };
    if !digest.eq_ignore_ascii_case(expected) {
        return false;
    }

    match recorded_len {
        None => true,
        Some(expected_len) => model_path(size)
            .ok()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|meta| meta.len() == expected_len)
            .unwrap_or(false),
    }
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

/// Resolve the preferred model, falling back to any verified local model.
///
/// Older configurations can point at a model that was removed or predates the
/// checksum-marker migration. Dictation should still work when another trusted
/// model is already installed instead of failing only after recording finishes.
pub fn resolve_verified_model(size: &str) -> Result<(String, PathBuf), String> {
    if let Ok(path) = verified_model_path(size) {
        return Ok((size.to_string(), path));
    }

    MODEL_SPECS
        .iter()
        .find_map(|spec| {
            verified_model_path(spec.size)
                .ok()
                .map(|path| (spec.size.to_string(), path))
        })
        .ok_or_else(|| {
            format!(
                "No verified Whisper model is ready. Download or verify '{}' in Dictation settings before recording",
                size
            )
        })
}

/// List all known Whisper models and their download status.
#[tauri::command]
pub fn list_whisper_models() -> Result<Vec<WhisperModelInfo>, String> {
    let mut models = Vec::with_capacity(MODEL_SPECS.len());

    for spec in MODEL_SPECS {
        let path = model_path(spec.size)?;
        let installed = path.is_file();
        let downloaded = installed && has_verified_marker(spec.size, spec.sha256);
        models.push(WhisperModelInfo {
            size: spec.size.to_string(),
            downloaded,
            installed,
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

    // Download to a temporary file first, then rename on success.
    //
    // The temp name is unique per call. It used to be a fixed
    // `ggml-<size>.bin.downloading`, so two concurrent downloads of the same
    // model truncated and interleaved writes into the *same* file while each
    // one hashed only the bytes it had personally received. Both checksums
    // passed, both renamed the interleaved garbage into place, and both wrote a
    // "verified" marker — a corrupt model treated as valid.
    let temp_path = dir.join(format!(
        "ggml-{}.bin.{}{}-{}.downloading",
        size,
        TEMP_PID_PREFIX,
        std::process::id(),
        DOWNLOAD_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    // Unique names mean a partial left behind by a crash or a power loss is
    // never overwritten by the next attempt, so sweep other processes' orphans
    // before adding one of our own. Files tagged with *this* process id are
    // skipped: a concurrent download may still be writing them.
    sweep_orphaned_downloads(&dir, &size).await;

    let streamed =
        stream_model_to_temp(response, &temp_path, &app_handle, &size, spec, total_size).await;

    // Any failure (connection drop, disk full, killed transfer) must not leave a
    // multi-gigabyte partial behind; the unique name means leftovers accumulate
    // instead of being overwritten by the next attempt.
    let (actual_sha256, downloaded) = match streamed {
        Ok(value) => value,
        Err(err) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(err);
        }
    };

    if !actual_sha256.eq_ignore_ascii_case(spec.sha256) {
        let _ = tokio::fs::remove_file(&temp_path).await;
        let truncated = total_size > 0 && downloaded < total_size;
        return Err(if truncated {
            format!(
                "Whisper model '{}' download was cut short ({} of {} bytes); try again",
                size, downloaded, total_size
            )
        } else {
            format!(
                "Whisper model checksum mismatch for '{}': expected {}, received {}",
                size, spec.sha256, actual_sha256
            )
        });
    }

    // Re-hash the finished file from disk. The streamed hash only proves what
    // came off the wire; this proves what is actually stored, so nothing that
    // was clobbered or short-written on the way to disk can be marked verified.
    if !verify_file_checksum(&temp_path, spec.sha256).await? {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!(
            "Whisper model '{}' did not survive being written to disk; try again",
            size
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

/// Per-process counter that makes each download's temp file name unique.
static DOWNLOAD_SEQ: AtomicU64 = AtomicU64::new(0);

/// Marks the process-id field of a temp download name.
const TEMP_PID_PREFIX: &str = "pid";

/// Does `name` look like `ggml-<size>.bin.pid<N>-<M>.downloading` from a process
/// other than this one?
fn is_orphaned_download(name: &str, size: &str, current_pid: u32) -> bool {
    let Some(rest) = name.strip_prefix(&format!("ggml-{size}.bin.{TEMP_PID_PREFIX}")) else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".downloading") else {
        return false;
    };
    match rest.split_once('-') {
        Some((pid, _seq)) => pid
            .parse::<u32>()
            .map(|p| p != current_pid)
            .unwrap_or(false),
        None => false,
    }
}

/// Remove partial downloads for `size` that were left behind by a previous run.
async fn sweep_orphaned_downloads(dir: &std::path::Path, size: &str) {
    let current_pid = std::process::id();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if is_orphaned_download(name, size, current_pid) {
            warn!("Removing orphaned partial model download {name}");
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

/// Stream a model response into `temp_path`, returning `(sha256, bytes_written)`.
///
/// Errors leave the temp file in place for the caller to remove.
async fn stream_model_to_temp(
    mut response: reqwest::Response,
    temp_path: &std::path::Path,
    app_handle: &tauri::AppHandle,
    size: &str,
    spec: &ModelSpec,
    total_size: u64,
) -> Result<(String, u64), String> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(temp_path)
        .await
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut last_percent: u32 = 0;
    let mut hasher = Sha256::new();

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Download error: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write chunk (is the disk full?): {e}"))?;
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
                    size: size.to_string(),
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
        .map_err(|e| format!("Failed to sync file (is the disk full?): {e}"))?;
    drop(file);

    Ok((format!("{:x}", hasher.finalize()), downloaded))
}

/// Delete a downloaded model file.
#[tauri::command]
pub fn delete_whisper_model(size: String) -> Result<(), String> {
    // Validate before building any path. `size` arrives from the frontend and
    // is interpolated straight into a filename, so an unvalidated value such as
    // "../../.ssh/id_ed25519" escaped the models directory and let this command
    // delete an arbitrary file under the home directory.
    let size = model_spec(&size)
        .ok_or_else(|| format!("Unknown model size '{}'", size))?
        .size;

    let path = model_path(size)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete model file: {e}"))?;
        info!("Deleted model ggml-{}.bin", size);
    }
    if let Ok(marker) = checksum_marker_path(size) {
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
    let model = model_path(size)?;
    let length = tokio::fs::metadata(&model)
        .await
        .map_err(|e| format!("Failed to stat verified model {:?}: {e}", model))?
        .len();

    let marker = checksum_marker_path(size)?;
    let mut file = tokio::fs::File::create(&marker)
        .await
        .map_err(|e| format!("Failed to create checksum marker: {e}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(format!("{} {}\n", expected, length).as_bytes())
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
    fn orphaned_partial_downloads_are_recognized_by_owning_process() {
        let mine = std::process::id();
        let other = mine.wrapping_add(1);

        assert!(is_orphaned_download(
            &format!("ggml-base.bin.pid{other}-0.downloading"),
            "base",
            mine
        ));
        // Never sweep a download this process may still be writing.
        assert!(!is_orphaned_download(
            &format!("ggml-base.bin.pid{mine}-3.downloading"),
            "base",
            mine
        ));
        // Never sweep another model, the finished model, or its marker.
        assert!(!is_orphaned_download(
            &format!("ggml-small.bin.pid{other}-0.downloading"),
            "base",
            mine
        ));
        assert!(!is_orphaned_download("ggml-base.bin", "base", mine));
        assert!(!is_orphaned_download("ggml-base.bin.sha256", "base", mine));
        assert!(!is_orphaned_download(
            "ggml-base.bin.pidxyz-0.downloading",
            "base",
            mine
        ));
    }

    #[test]
    fn checksum_markers_carry_a_length_and_stay_backward_compatible() {
        let digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(
            parse_checksum_marker(&format!("{digest} 147964211\n")),
            Some((digest.to_string(), Some(147_964_211)))
        );
        // Markers written before lengths were recorded.
        assert_eq!(
            parse_checksum_marker(&format!("{digest}\n")),
            Some((digest.to_string(), None))
        );
        assert_eq!(parse_checksum_marker("   \n"), None);
    }

    #[test]
    fn unknown_model_sizes_cannot_escape_the_models_directory() {
        // `delete_whisper_model` interpolates `size` into a filename, so this
        // must be rejected before any path is built.
        for evil in ["../../.ssh/id_ed25519", "..", "base/../../secrets", ""] {
            assert!(model_spec(evil).is_none(), "{evil} must not resolve");
            assert!(delete_whisper_model(evil.to_string()).is_err());
        }
        assert!(model_spec("base").is_some());
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
