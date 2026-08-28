use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use tracing::{info, warn};
use whisper_rs::{
    get_lang_str, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

pub struct TranscriptionOutcome {
    pub text: String,
    pub detected_language: Option<String>,
    pub model_load_ms: u64,
    pub inference_ms: u64,
    /// True when this run was superseded (a newer capture started) or
    /// explicitly cancelled. `text` is always empty in that case so a stale
    /// result can never be delivered into whatever the user is typing into now.
    ///
    /// Unread until `stop_recording` distinguishes "cancelled" from "silence"
    /// in the status it emits; the empty `text` already makes both safe.
    #[allow(dead_code)]
    pub cancelled: bool,
}

/// Shared state holding a lazily-loaded Whisper model context.
/// Managed via `tauri::State<WhisperState>` and registered in lib.rs.
#[derive(Clone)]
pub struct WhisperState {
    /// The loaded model context, or None if no model has been loaded yet.
    inner: Arc<Mutex<Option<LoadedModel>>>,
    /// Monotonic run token. Every `transcribe_audio` call claims the newest
    /// value; `cancel()` and any newer call invalidate the runs before it.
    /// whisper.cpp polls this through an abort callback, so an abandoned
    /// transcription stops burning CPU instead of finishing and returning a
    /// stale transcript minutes later.
    run_epoch: Arc<AtomicU64>,
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
            run_epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Abandon any transcription that is currently running.
    ///
    /// Call this from `cancel_recording` so a capture the user cancelled mid
    /// transcription cannot land in a field they have since moved on from.
    ///
    /// Wired 2026-08-28: `audio::cancel_recording` takes `State<WhisperState>`
    /// and calls this before tearing the capture down. Bumping the epoch when
    /// nothing is in flight is harmless — `begin_run` claims a strictly newer
    /// token, so a cancel can never reach forward into a future capture.
    pub fn cancel(&self) {
        self.run_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Claim the newest run token, invalidating every earlier in-flight run.
    fn begin_run(&self) -> u64 {
        self.run_epoch.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_superseded(&self, run: u64) -> bool {
        self.run_epoch.load(Ordering::SeqCst) != run
    }
}

/// Lock the model cache, recovering from poisoning.
///
/// Failure mode this guards: a panic anywhere under this lock (whisper-rs
/// panics on a NUL byte in a prompt or language string, for example) used to
/// poison the mutex permanently, so every later dictation failed with
/// "Lock poisoned" until the app was restarted. On recovery we drop the cached
/// context so the next call re-loads a known-good one.
fn lock_model(inner: &Mutex<Option<LoadedModel>>) -> MutexGuard<'_, Option<LoadedModel>> {
    match inner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("Whisper model lock was poisoned by an earlier panic; discarding cached context");
            let mut guard = poisoned.into_inner();
            *guard = None;
            guard
        }
    }
}

/// Shortest capture worth running inference on, in 16 kHz mono samples.
///
/// whisper.cpp itself bails out below 100 ms (`delta_min` in `whisper_full`)
/// and returns zero segments, so anything under this produces no text anyway.
/// Checking here means an accidental push-to-talk tap does not pay a
/// multi-second first-model-load before producing nothing.
const MIN_TRANSCRIBABLE_SAMPLES: usize = 1_600;

/// Strip characters whisper-rs cannot put in a C string.
///
/// Failure mode: `FullParams::set_language` calls `CString::new(..).expect(..)`,
/// so a NUL byte in a hand-edited or corrupted `dictation.json` panicked the
/// blocking transcription thread instead of returning an error.
fn sanitize_language(language: &str) -> String {
    language.trim().replace('\0', "")
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
/// * `model_path` - Path to the GGML model file (e.g. `~/.packetbench/models/ggml-base.bin`)
///
/// # Returns
/// The transcribed text with hallucination artifacts removed, or an error string.
pub fn transcribe_audio(
    whisper_state: &WhisperState,
    audio: Vec<f32>,
    model_path: &str,
    language: &str,
    custom_dictionary: &[String],
) -> Result<TranscriptionOutcome, String> {
    if audio.is_empty() {
        return Err("No audio data to transcribe".into());
    }

    // Sub-100 ms taps: return nothing rather than loading a multi-gigabyte model
    // to produce nothing. See MIN_TRANSCRIBABLE_SAMPLES.
    if audio.len() < MIN_TRANSCRIBABLE_SAMPLES {
        warn!(
            samples = audio.len(),
            "Capture is shorter than 100 ms; skipping transcription"
        );
        return Ok(TranscriptionOutcome {
            text: String::new(),
            detected_language: None,
            model_load_ms: 0,
            inference_ms: 0,
            cancelled: false,
        });
    }

    // Claim this run before taking the model lock. A second capture that starts
    // while this one is still loading/inferring supersedes it immediately rather
    // than queueing behind the lock and delivering two transcripts.
    let run = whisper_state.begin_run();
    let cancelled_outcome = || TranscriptionOutcome {
        text: String::new(),
        detected_language: None,
        model_load_ms: 0,
        inference_ms: 0,
        cancelled: true,
    };

    let model_path_str = model_path.to_string();
    let inner = whisper_state.inner.clone();

    // Sanitize before `params` is created: the borrow must outlive FullParams.
    let language = sanitize_language(language);

    // Ensure the model is loaded (lazy-load or reload if path changed).
    // A single lock scope spans load + inference: releasing it in between let a
    // concurrent call swap the cached context, so inference could silently run
    // on a different model than `model_path`.
    let mut guard = lock_model(&inner);
    let mut model_load_ms = 0;

    let needs_load = match guard.as_ref() {
        None => true,
        Some(loaded) => loaded.model_path != model_path_str,
    };

    if needs_load {
        if whisper_state.is_superseded(run) {
            return Ok(cancelled_outcome());
        }
        let load_started = Instant::now();
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
        model_load_ms = elapsed_millis(load_started);
        info!("Whisper model loaded successfully");
    }

    // A cancel that arrived while the model was loading must not start inference.
    if whisper_state.is_superseded(run) {
        return Ok(cancelled_outcome());
    }

    // Run inference (this is CPU-intensive, so the caller should use spawn_blocking)
    let loaded = guard
        .as_ref()
        .ok_or_else(|| "Model not loaded (unexpected)".to_string())?;

    let mut state = loaded
        .ctx
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    // Configure transcription parameters
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });

    // Detect language unless the user selected a specific Whisper language code.
    params.set_language(
        if language.is_empty() || language.eq_ignore_ascii_case("auto") {
            None
        } else {
            Some(language.as_str())
        },
    );
    params.set_translate(false);

    // Let whisper.cpp abandon a superseded/cancelled run mid-encode instead of
    // spending minutes on a long capture nobody is waiting for any more.
    let abort_epoch = Arc::clone(&whisper_state.run_epoch);
    params.set_abort_callback_safe(move || abort_epoch.load(Ordering::SeqCst) != run);

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

    // Bias recognition toward programming terms plus the user's project words.
    let initial_prompt = build_initial_prompt(custom_dictionary);
    params.set_initial_prompt(&initial_prompt);

    // Run the transcription
    let inference_started = Instant::now();
    let full_result = state.full(params, &audio);
    // An aborted run surfaces as a whisper.cpp encode/decode failure. Report it
    // as a cancellation, not as a scary "Transcription failed: -6" toast.
    if whisper_state.is_superseded(run) {
        info!("Transcription was cancelled or superseded; discarding partial result");
        return Ok(cancelled_outcome());
    }
    full_result.map_err(|e| format!("Transcription failed: {e}"))?;
    let inference_ms = elapsed_millis(inference_started);
    let detected_language = get_lang_str(state.full_lang_id_from_state()).map(ToString::to_string);

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
        return Ok(TranscriptionOutcome {
            text: String::new(),
            detected_language,
            model_load_ms,
            inference_ms,
            cancelled: false,
        });
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

    Ok(TranscriptionOutcome {
        text: trimmed,
        detected_language,
        model_load_ms,
        inference_ms,
        cancelled: false,
    })
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn build_initial_prompt(custom_dictionary: &[String]) -> String {
    const MAX_CUSTOM_TERMS: usize = 100;
    const MAX_CUSTOM_CHARS: usize = 1_024;

    let mut seen = std::collections::HashSet::new();
    let mut custom = String::new();

    for raw in custom_dictionary.iter().take(MAX_CUSTOM_TERMS) {
        let sanitized = raw.replace('\0', "");
        let normalized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_lowercase();
        if !seen.insert(key) {
            continue;
        }

        let separator_len = usize::from(!custom.is_empty());
        if custom.len() + separator_len + normalized.len() > MAX_CUSTOM_CHARS {
            break;
        }
        if !custom.is_empty() {
            custom.push(' ');
        }
        custom.push_str(&normalized);
    }

    if custom.is_empty() {
        PROGRAMMING_VOCAB_PROMPT.to_string()
    } else {
        // User terms go first so Whisper's prompt-token cap cannot discard
        // them behind the larger built-in developer vocabulary.
        format!("{custom} {PROGRAMMING_VOCAB_PROMPT}")
    }
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
    result.trim().to_string()
}

/// Detect if the transcription is numeric garbage (a common Whisper hallucination
/// on silence or very low audio). Returns true if the text is mostly numbers,
/// scientific notation, dashes, and dots with very few actual words.
///
/// Two false-positive guards, because this is a *programming* dictation tool and
/// the previous 10-byte threshold silently discarded legitimate short numeric
/// utterances: dictating "192.168.1.1", "127.0.0.1:8080" or "0.10.3-beta.2"
/// produced no text and no explanation.
///
/// * A single word-like token (two or more consecutive letters) means real
///   speech. Whisper's silence garbage is pure numerals and scientific
///   notation, so one real word is enough to keep the transcript -- "port 8080
///   3000 5432 1234 9999" was otherwise discarded as numeric noise.
/// * The length floor counts characters, not bytes, so a non-ASCII transcript is
///   judged on the same basis as an ASCII one.
fn is_numeric_hallucination(text: &str) -> bool {
    /// Silence garbage runs long ("-1.0e-5 -2.3e-6 ..."); real numeric dictation
    /// is usually one short token.
    const MIN_CHARS: usize = 24;

    let total = text.chars().count();
    if total < MIN_CHARS {
        return false;
    }

    let word_like = text
        .split_whitespace()
        .filter(|token| {
            token
                .chars()
                .collect::<Vec<_>>()
                .windows(2)
                .any(|pair| pair[0].is_alphabetic() && pair[1].is_alphabetic())
        })
        .count();
    if word_like >= 1 {
        return false;
    }

    let numeric_chars = text
        .chars()
        .filter(|c| {
            c.is_ascii_digit() || *c == '.' || *c == '-' || *c == 'e' || *c == 'E' || *c == '+'
        })
        .count() as f64;

    // If more than 60% of the text is numeric/scientific notation chars, it's garbage
    (numeric_chars / total as f64) > 0.6
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

    #[test]
    fn numeric_hallucination_keeps_short_technical_dictation() {
        // Regression: these were discarded as "numeric garbage" and the user saw
        // an empty transcript with no explanation.
        assert!(!is_numeric_hallucination("192.168.1.1"));
        assert!(!is_numeric_hallucination("127.0.0.1:8080"));
        assert!(!is_numeric_hallucination("0.10.3-beta.2"));
        assert!(!is_numeric_hallucination("2026-08-27T14:05:09Z"));
    }

    #[test]
    fn numeric_hallucination_still_discards_silence_garbage() {
        assert!(is_numeric_hallucination(
            "-1.0e-5 -2.3e-6 -3.4e-7 -4.5e-8 -5.6e-9 -6.7e-10"
        ));
    }

    #[test]
    fn numeric_hallucination_keeps_text_with_real_words() {
        assert!(!is_numeric_hallucination(
            "port 8080 3000 5432 1234 9999 4321 8443 7777"
        ));
    }

    #[test]
    fn numeric_hallucination_length_floor_counts_characters_not_bytes() {
        // 12 multi-byte chars = 36 bytes: over the old byte floor, under the
        // character floor, so it must not be judged at all.
        assert!(!is_numeric_hallucination(&"。".repeat(12)));
    }

    #[test]
    fn sanitize_language_strips_nul_bytes_that_would_panic_whisper_rs() {
        assert_eq!(sanitize_language("  en\0 "), "en");
        assert_eq!(sanitize_language("auto"), "auto");
        assert_eq!(sanitize_language("\0"), "");
    }

    #[test]
    fn short_captures_return_empty_without_touching_the_model() {
        let state = WhisperState::new();
        // Deliberately unreadable path: reaching the loader would error.
        let outcome = transcribe_audio(
            &state,
            vec![0.01_f32; MIN_TRANSCRIBABLE_SAMPLES - 1],
            "/nonexistent/ggml-does-not-exist.bin",
            "auto",
            &[],
        )
        .expect("a sub-100ms tap must not be an error");
        assert!(outcome.text.is_empty());
        assert!(!outcome.cancelled);
        assert_eq!(outcome.model_load_ms, 0);
    }

    #[test]
    fn empty_audio_is_still_reported_as_a_capture_failure() {
        let state = WhisperState::new();
        assert!(transcribe_audio(&state, Vec::new(), "/nonexistent.bin", "auto", &[]).is_err());
    }

    #[test]
    fn cancel_supersedes_the_active_run() {
        let state = WhisperState::new();
        let run = state.begin_run();
        assert!(!state.is_superseded(run));
        state.cancel();
        assert!(state.is_superseded(run));
    }

    #[test]
    fn a_newer_run_supersedes_an_older_one() {
        let state = WhisperState::new();
        let first = state.begin_run();
        let second = state.begin_run();
        assert!(state.is_superseded(first));
        assert!(!state.is_superseded(second));
    }

    #[test]
    fn poisoned_model_lock_recovers_instead_of_bricking_dictation() {
        let state = WhisperState::new();
        let inner = state.inner.clone();
        let _ = std::thread::spawn(move || {
            let _guard = inner.lock().unwrap();
            panic!("simulated whisper panic while holding the model lock");
        })
        .join();
        assert!(state.inner.is_poisoned());
        // Previously every later call returned "Lock poisoned" until restart.
        let guard = lock_model(&state.inner);
        assert!(guard.is_none());
    }

    #[test]
    fn custom_dictionary_is_normalized_deduplicated_and_bounded() {
        let prompt = build_initial_prompt(&[
            " PacketBench ".to_string(),
            "packetbench".to_string(),
            "Flight   Deck".to_string(),
            "\0".to_string(),
            "x".repeat(2_000),
        ]);
        assert!(prompt.starts_with("PacketBench Flight Deck "));
        assert_eq!(prompt.matches("PacketBench").count(), 1);
        assert!(prompt.len() <= PROGRAMMING_VOCAB_PROMPT.len() + 1 + 1_024);
    }
}
