use std::path::Path;
use std::sync::{Arc, Mutex};

use tracing::{info, warn};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Shared state holding a lazily-loaded Whisper model context.
/// Managed via `tauri::State<WhisperState>` and registered in lib.rs.
pub struct WhisperState {
    /// The loaded model context, or None if no model has been loaded yet.
    inner: Arc<Mutex<Option<LoadedModel>>>,
}

struct LoadedModel {
    ctx: WhisperContext,
    /// Path of the model file that was loaded, so we can detect model changes.
    model_path: String,
}

// WhisperContext is Send+Sync via its Arc<WhisperInnerContext>
unsafe impl Send for LoadedModel {}
unsafe impl Sync for LoadedModel {}

impl WhisperState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Unload the currently loaded model (if any).
    pub fn unload(&self) {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            info!("Unloading Whisper model");
            *guard = None;
        }
    }
}

impl Default for WhisperState {
    fn default() -> Self {
        Self::new()
    }
}

/// Programming-focused initial prompt that biases Whisper toward technical vocabulary.
const PROGRAMMING_VOCAB_PROMPT: &str = "\
AWS S3 EC2 Lambda DynamoDB GCP Azure Vercel Railway \
JavaScript TypeScript Python Rust Go Java Swift Kotlin \
React Vue Angular Next.js Django FastAPI \
MongoDB PostgreSQL MySQL SQLite Redis \
Docker Kubernetes Terraform CI/CD GitHub Actions \
REST GraphQL gRPC WebSocket OAuth JWT \
Claude GPT Gemini LLM embedding RAG \
API SDK CLI npm pnpm yarn cargo pip conda \
git branch merge rebase commit push pull request \
deploy container microservice serverless webhook endpoint middleware \
authentication authorization encryption TLS SSL HTTP HTTPS \
JSON YAML TOML CSV XML HTML CSS SCSS Tailwind \
TypeScript interface type enum const async await Promise callback \
useState useEffect useRef component props state render layout \
grid flex responsive breakpoint viewport \
Tauri Vite Webpack Babel ESLint Prettier \
struct impl fn pub mod crate trait derive macro \
HashMap Vec Option Result String str \
println eprintln format writeln assert \
tokio spawn async move Arc Mutex RwLock \
Node Express Fastify Koa Deno Bun \
pytest unittest mock fixture parametrize \
Dockerfile compose volume network port \
kubectl helm ingress pod service namespace \
terraform provider resource module output variable \
PostgreSQL index query migration schema table column \
localhost endpoint route handler controller service \
boolean integer float string array object null undefined \
import export default require module package \
class method constructor prototype inheritance \
try catch finally throw error exception \
if else switch case break continue return \
for while loop map filter reduce forEach \
function arrow callback closure scope hoisting \
variable constant let var declaration assignment \
npm install uninstall update publish link \
git clone fetch pull push status log diff \
SSH RSA ECDSA GPG certificate key token secret \
base64 SHA256 MD5 HMAC AES RSA encryption \
regex pattern match replace split join trim \
WebAssembly WASM binary module instance memory \
Canvas SVG WebGL animation transition transform \
localStorage sessionStorage IndexedDB cookie cache \
fetch XMLHttpRequest axios request response header \
stdin stdout stderr pipe redirect";

/// Artifacts that Whisper sometimes hallucinates on silent or near-silent audio.
const HALLUCINATION_ARTIFACTS: &[&str] = &[
    "[BLANK_AUDIO]",
    "[silence]",
    "[inaudible]",
    "[no speech]",
    "[music]",
    "(silence)",
    "(no speech)",
    "(inaudible)",
    "(music)",
    "[MUSIC]",
    "[NOISE]",
    "[ Silence ]",
    "[Silence]",
    "(blank audio)",
    "[blank_audio]",
];

/// Transcribe a buffer of f32 PCM audio (mono, 16 kHz) using whisper.cpp.
///
/// This is not a Tauri command — it is called internally by `stop_recording` in the
/// audio module. It lazy-loads the model on first use and caches it for subsequent calls.
///
/// # Arguments
/// * `whisper_state` - Shared Whisper context state managed by Tauri
/// * `audio` - PCM audio samples as f32, mono channel, 16 kHz sample rate
/// * `model_path` - Path to the GGML model file (e.g. `~/.packetcode/models/ggml-base.bin`)
///
/// # Returns
/// The transcribed text with hallucination artifacts removed, or an error string.
pub fn transcribe_audio(
    whisper_state: &WhisperState,
    audio: Vec<f32>,
    model_path: &str,
) -> Result<String, String> {
    if audio.is_empty() {
        return Err("No audio data to transcribe".into());
    }

    let model_path_str = model_path.to_string();
    let inner = whisper_state.inner.clone();

    // Ensure the model is loaded (lazy-load or reload if path changed)
    {
        let mut guard = inner.lock().map_err(|e| format!("Lock poisoned: {e}"))?;

        let needs_load = match guard.as_ref() {
            None => true,
            Some(loaded) => loaded.model_path != model_path_str,
        };

        if needs_load {
            let path = Path::new(&model_path_str);
            if !path.exists() {
                return Err(format!(
                    "Model file not found: {}. Download it first via the Models panel.",
                    model_path_str
                ));
            }

            info!("Loading Whisper model from {}", model_path_str);
            let params = WhisperContextParameters::default();
            let ctx = WhisperContext::new_with_params(path, params)
                .map_err(|e| format!("Failed to load Whisper model: {e}"))?;

            *guard = Some(LoadedModel {
                ctx,
                model_path: model_path_str.clone(),
            });
            info!("Whisper model loaded successfully");
        }
    }

    // Run inference (this is CPU-intensive, so the caller should use spawn_blocking)
    let guard = inner.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let loaded = guard
        .as_ref()
        .ok_or_else(|| "Model not loaded (unexpected)".to_string())?;

    let mut state = loaded
        .ctx
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    // Configure transcription parameters
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });

    // Use English language
    params.set_language(Some("en"));
    params.set_translate(false);

    // Suppress console output
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    // Single-segment mode is fine for dictation (typically short utterances)
    params.set_single_segment(false);
    params.set_no_timestamps(true);

    // Use available threads (leave one for the system)
    let n_threads = std::thread::available_parallelism()
        .map(|p| p.get() as i32)
        .unwrap_or(4)
        .max(1)
        .min(8);
    params.set_n_threads(n_threads);

    // Set programming vocabulary as initial prompt to bias recognition
    params.set_initial_prompt(PROGRAMMING_VOCAB_PROMPT);

    // Run the transcription
    state
        .full(params, &audio)
        .map_err(|e| format!("Transcription failed: {e}"))?;

    // Collect all segment text
    let n_segments = state.full_n_segments();
    let mut text = String::new();

    for i in 0..n_segments {
        if let Some(segment) = state.get_segment(i) {
            match segment.to_str() {
                Ok(s) => text.push_str(s),
                Err(_) => {
                    // Fall back to lossy conversion
                    if let Ok(lossy) = segment.to_str_lossy() {
                        text.push_str(&lossy);
                    }
                }
            }
        }
    }

    // Filter out hallucination artifacts
    let cleaned = filter_artifacts(&text);
    let trimmed = cleaned.trim().to_string();

    // Detect numeric garbage hallucination (common on silence/low audio)
    if is_numeric_hallucination(&trimmed) {
        warn!("Whisper produced numeric hallucination (likely silence), discarding");
        return Ok(String::new());
    }

    if trimmed.is_empty() {
        warn!("Whisper produced empty transcription (possible silence)");
    } else {
        info!(
            "Transcribed {} characters from {} segments",
            trimmed.len(),
            n_segments
        );
    }

    Ok(trimmed)
}

/// Remove known Whisper hallucination artifacts from transcription output.
fn filter_artifacts(text: &str) -> String {
    let mut result = text.to_string();
    for artifact in HALLUCINATION_ARTIFACTS {
        result = result.replace(artifact, "");
    }
    // Collapse multiple spaces that may result from artifact removal
    while result.contains("  ") {
        result = result.replace("  ", " ");
    }
    result
}

/// Detect if the transcription is numeric garbage (a common Whisper hallucination
/// on silence or very low audio). Returns true if the text is mostly numbers,
/// scientific notation, dashes, and dots with very few actual words.
fn is_numeric_hallucination(text: &str) -> bool {
    if text.len() < 10 {
        return false;
    }
    let total = text.len() as f64;
    let numeric_chars = text
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == 'e' || *c == 'E' || *c == '+')
        .count() as f64;

    // If more than 60% of the text is numeric/scientific notation chars, it's garbage
    (numeric_chars / total) > 0.6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filter_artifacts_removes_blank_audio() {
        let input = "Hello [BLANK_AUDIO] world";
        assert_eq!(filter_artifacts(input), "Hello world");
    }

    #[test]
    fn test_filter_artifacts_removes_multiple() {
        let input = "[silence] Hello [no speech] world [music]";
        assert_eq!(filter_artifacts(input), "Hello world");
    }

    #[test]
    fn test_filter_artifacts_preserves_clean_text() {
        let input = "This is a normal transcription.";
        assert_eq!(filter_artifacts(input), "This is a normal transcription.");
    }

    #[test]
    fn test_filter_artifacts_empty() {
        let input = "[BLANK_AUDIO]";
        assert_eq!(filter_artifacts(input), "");
    }
}
