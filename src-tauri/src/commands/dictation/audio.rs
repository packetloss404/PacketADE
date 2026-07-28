use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use rustfft::{num_complex::Complex, FftPlanner};
use tauri::{AppHandle, Emitter};

use super::{history, models, models::AudioDevice, whisper};

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// Holds the recording buffer and control flags shared between the cpal
/// callback thread, the FFT/waveform emitter thread, and Tauri commands.
pub struct DictationState {
    pub buffer: Arc<Mutex<Vec<f32>>>,
    pub is_recording: Arc<AtomicBool>,
    /// Handle to the cpal stream so we can stop it on `stop_recording`.
    stream: Arc<Mutex<Option<cpal::Stream>>>,
    /// Flag used to tell the waveform emitter thread to exit.
    emitter_running: Arc<AtomicBool>,
    /// Native mono sample rate captured from the selected device.
    sample_rate: Arc<AtomicU32>,
    /// Used to calculate history duration and words-per-minute.
    started_at: Arc<Mutex<Option<Instant>>>,
    /// Invalidates detached waveform workers when a new recording begins.
    recording_generation: Arc<AtomicU64>,
}

/// Create the managed `DictationState` — call this once at app startup.
pub fn create_dictation_state() -> DictationState {
    DictationState {
        buffer: Arc::new(Mutex::new(Vec::new())),
        is_recording: Arc::new(AtomicBool::new(false)),
        stream: Arc::new(Mutex::new(None)),
        emitter_running: Arc::new(AtomicBool::new(false)),
        sample_rate: Arc::new(AtomicU32::new(16_000)),
        started_at: Arc::new(Mutex::new(None)),
        recording_generation: Arc::new(AtomicU64::new(0)),
    }
}

struct StartGuard {
    is_recording: Arc<AtomicBool>,
    committed: bool,
}

impl StartGuard {
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        if !self.committed {
            self.is_recording.store(false, Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Return the list of available audio input devices.
#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();

    let default_device_name = host
        .default_input_device()
        .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()));

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?;

    let mut result: Vec<AudioDevice> = Vec::new();
    for (idx, device) in devices.enumerate() {
        let name = device
            .description()
            .map(|desc| desc.name().to_string())
            .unwrap_or_else(|_| format!("Device {}", idx));
        let is_default = default_device_name
            .as_ref()
            .map(|d| d == &name)
            .unwrap_or(false);
        result.push(AudioDevice {
            index: idx as u32,
            name,
            is_default,
        });
    }

    Ok(result)
}

/// Start recording from the specified (or default) audio input device.
///
/// Opens the device's supported default input stream, converts it to mono f32,
/// and spawns a thread that computes a 512-point FFT every ~33 ms
/// to emit 25 exponential frequency bars via the `dictation:waveform` event.
#[tauri::command]
pub fn start_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, DictationState>,
    device_index: Option<u32>,
) -> Result<(), String> {
    state
        .is_recording
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Already recording".to_string())?;
    let mut start_guard = StartGuard {
        is_recording: Arc::clone(&state.is_recording),
        committed: false,
    };

    let host = cpal::default_host();
    let settings = super::config::read_dictation_config()?;
    // Fail before opening the microphone instead of after the user has spoken.
    models::resolve_verified_model(&settings.model_size)?;

    // Pick the device ---------------------------------------------------
    let selected_device_index = device_index.or(settings.device_index);
    let device = if let Some(idx) = selected_device_index {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .nth(idx as usize)
            .ok_or_else(|| format!("No input device at index {}", idx))?
    } else {
        host.default_input_device()
            .ok_or_else(|| "No default input device available".to_string())?
    };

    // Use the device's actual supported format. Requiring exact 16 kHz mono
    // f32 fails on common Windows microphones (usually 44.1/48 kHz stereo).
    let supported_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to read the microphone's default format: {e}"))?;
    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();
    let channels = usize::from(config.channels);
    let sample_rate = config.sample_rate;
    let device_name = device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| "Unknown microphone".to_string());
    tracing::info!(
        device = %device_name,
        sample_rate,
        channels,
        sample_format = ?sample_format,
        "Starting dictation capture"
    );
    state.sample_rate.store(sample_rate, Ordering::SeqCst);

    // Shared buffer for cpal callback → FFT thread
    let buf = Arc::clone(&state.buffer);
    {
        let mut b = buf.lock().map_err(|e| e.to_string())?;
        b.clear();
    }

    let stream = match sample_format {
        SampleFormat::I8 => build_input_stream::<i8>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::I16 => build_input_stream::<i16>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::I24 => build_input_stream::<cpal::I24>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::I32 => build_input_stream::<i32>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::I64 => build_input_stream::<i64>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::U8 => build_input_stream::<u8>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::U16 => build_input_stream::<u16>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::U24 => build_input_stream::<cpal::U24>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::U32 => build_input_stream::<u32>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::U64 => build_input_stream::<u64>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::F32 => build_input_stream::<f32>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        SampleFormat::F64 => build_input_stream::<f64>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
        ),
        unsupported => Err(format!(
            "Microphone sample format '{unsupported}' is not supported for dictation"
        )),
    }?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {}", e))?;

    // Store stream handle so we can stop it later -----------------------
    {
        let mut s = state.stream.lock().map_err(|e| e.to_string())?;
        *s = Some(stream);
    }

    state.emitter_running.store(true, Ordering::SeqCst);
    *state.started_at.lock().map_err(|e| e.to_string())? = Some(Instant::now());
    let generation = state.recording_generation.fetch_add(1, Ordering::SeqCst) + 1;
    start_guard.commit();

    // Spawn waveform emitter thread -------------------------------------
    let emitter_buf = Arc::clone(&buf);
    let emitter_running = Arc::clone(&state.emitter_running);
    let active_generation = Arc::clone(&state.recording_generation);
    let handle = app_handle.clone();

    std::thread::spawn(move || {
        const FFT_SIZE: usize = 512;
        const NUM_BARS: usize = 25;
        const RMS_THRESHOLD: f32 = 0.005;
        const FRAME_INTERVAL: std::time::Duration = std::time::Duration::from_millis(33);

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);

        // Precompute Hanning window
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                0.5 * (1.0
                    - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos())
            })
            .collect();

        // Precompute exponential bar boundaries
        let bar_boundaries: Vec<usize> = (0..=NUM_BARS)
            .map(|i| {
                let frac = i as f32 / NUM_BARS as f32;
                // Map exponentially into the FFT bin range [0, FFT_SIZE/2)
                let bin = ((FFT_SIZE as f32 / 2.0).powf(frac)) as usize;
                bin.min(FFT_SIZE / 2)
            })
            .collect();

        while emitter_running.load(Ordering::SeqCst)
            && active_generation.load(Ordering::SeqCst) == generation
        {
            std::thread::sleep(FRAME_INTERVAL);

            // Grab the most recent FFT_SIZE samples
            let samples: Vec<f32> = {
                let b = match emitter_buf.lock() {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if b.len() < FFT_SIZE {
                    continue;
                }
                b[b.len() - FFT_SIZE..].to_vec()
            };

            // RMS silence gate
            let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
            if rms < RMS_THRESHOLD {
                let bars = vec![0.0f32; NUM_BARS];
                let _ = handle.emit("dictation:waveform", bars);
                continue;
            }

            // Apply Hanning window and convert to Complex
            let mut fft_input: Vec<Complex<f32>> = samples
                .iter()
                .zip(window.iter())
                .map(|(s, w)| Complex { re: s * w, im: 0.0 })
                .collect();

            fft.process(&mut fft_input);

            // Compute magnitude spectrum (first half only)
            let magnitudes: Vec<f32> = fft_input[..FFT_SIZE / 2].iter().map(|c| c.norm()).collect();

            // Map into NUM_BARS exponential bars, normalised to [0, 1]
            let max_mag = magnitudes.iter().cloned().fold(0.0f32, f32::max).max(1e-10);
            let bars: Vec<f32> = (0..NUM_BARS)
                .map(|i| {
                    let lo = bar_boundaries[i].max(1);
                    let hi = bar_boundaries[i + 1].max(lo + 1);
                    let avg = magnitudes[lo..hi.min(magnitudes.len())]
                        .iter()
                        .copied()
                        .sum::<f32>()
                        / (hi - lo).max(1) as f32;
                    (avg / max_mag).clamp(0.0, 1.0)
                })
                .collect();

            let _ = handle.emit("dictation:waveform", bars);
        }
    });

    Ok(())
}

/// Cancel a recording without transcribing or retaining its audio.
#[tauri::command]
pub fn cancel_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, DictationState>,
) -> Result<(), String> {
    let was_recording = state.is_recording.swap(false, Ordering::SeqCst);
    state.emitter_running.store(false, Ordering::SeqCst);
    state.recording_generation.fetch_add(1, Ordering::SeqCst);

    {
        let mut stream = state.stream.lock().map_err(|e| e.to_string())?;
        *stream = None;
    }
    {
        let mut buffer = state.buffer.lock().map_err(|e| e.to_string())?;
        buffer.clear();
    }
    *state.started_at.lock().map_err(|e| e.to_string())? = None;
    if was_recording {
        let _ = app_handle.emit("dictation:status", "idle");
    }
    Ok(())
}

/// Stop recording and return the transcribed text.
///
/// Emits a `dictation:status` event with `"transcribing"` so the UI can
/// show a spinner while the whisper module processes the audio.
#[tauri::command]
pub async fn stop_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, DictationState>,
    whisper_state: tauri::State<'_, whisper::WhisperState>,
) -> Result<String, String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Not currently recording".to_string());
    }

    // Signal the emitter thread to stop
    state.emitter_running.store(false, Ordering::SeqCst);
    state.recording_generation.fetch_add(1, Ordering::SeqCst);

    // Drop the cpal stream (stops recording)
    {
        let mut s = state.stream.lock().map_err(|e| e.to_string())?;
        *s = None;
    }

    state.is_recording.store(false, Ordering::SeqCst);

    // Grab the full buffer
    let audio = {
        let mut b = state.buffer.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *b)
    };
    let input_sample_rate = state.sample_rate.load(Ordering::SeqCst);
    let audio = resample_linear(&audio, input_sample_rate, 16_000);
    let duration_seconds = state
        .started_at
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .map(|started| started.elapsed().as_secs_f64());

    // Notify the frontend
    let _ = app_handle.emit("dictation:status", "transcribing");

    let settings = super::config::read_dictation_config()?;
    let (_, model_path) = models::resolve_verified_model(&settings.model_size)?;
    let model_path = model_path.to_string_lossy().to_string();
    let whisper_state = (*whisper_state).clone();

    let text = tokio::task::spawn_blocking(move || {
        whisper::transcribe_audio(
            &whisper_state,
            audio,
            &model_path,
            &settings.language,
            &settings.custom_dictionary,
        )
    })
    .await
    .map_err(|e| format!("Transcription task failed: {e}"))??;

    if !text.trim().is_empty() {
        let word_count = text.split_whitespace().count() as i64;
        let wpm = duration_seconds
            .filter(|duration| *duration > 0.0)
            .map(|duration| ((word_count as f64 / duration) * 60.0).round() as i64);
        if let Err(err) =
            history::insert_entry(&text, "transcribe", duration_seconds, Some(word_count), wpm)
        {
            // History is secondary to delivery. A locked/corrupt analytics DB
            // must not discard a successful local transcription.
            tracing::warn!("Failed to save dictation history entry: {err}");
        }
    }

    Ok(text)
}

fn build_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    buffer: Arc<Mutex<Vec<f32>>>,
    state: &tauri::State<'_, DictationState>,
    app_handle: &AppHandle,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    let is_recording = Arc::clone(&state.is_recording);
    let emitter_running = Arc::clone(&state.emitter_running);
    let error_handle = app_handle.clone();

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if let Ok(mut target) = buffer.lock() {
                    append_mono_samples(data, channels, &mut target);
                }
            },
            move |err| {
                tracing::error!("cpal input stream error: {err}");
                is_recording.store(false, Ordering::SeqCst);
                emitter_running.store(false, Ordering::SeqCst);
                let _ = error_handle.emit(
                    "dictation:error",
                    format!("Microphone stream stopped unexpectedly: {err}"),
                );
            },
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {e}"))
}

fn append_mono_samples<T>(input: &[T], channels: usize, output: &mut Vec<f32>)
where
    T: Copy,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    output.reserve(input.len() / channels);
    for frame in input.chunks_exact(channels) {
        let sum = frame.iter().copied().map(f32::from_sample).sum::<f32>();
        output.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
}

fn resample_linear(input: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
    if input.is_empty() || input_rate == 0 || output_rate == 0 {
        return Vec::new();
    }
    if input_rate == output_rate || input.len() == 1 {
        return input.to_vec();
    }

    let output_len =
        ((input.len() as f64 * output_rate as f64 / input_rate as f64).round() as usize).max(1);
    let step = input_rate as f64 / output_rate as f64;
    let mut output = Vec::with_capacity(output_len);

    for index in 0..output_len {
        let position = index as f64 * step;
        let left = (position.floor() as usize).min(input.len() - 1);
        let right = (left + 1).min(input.len() - 1);
        let fraction = (position - left as f64) as f32;
        output.push(input[left] + (input[right] - input[left]) * fraction);
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_interleaved_stereo_audio() {
        let mut output = Vec::new();
        append_mono_samples(&[1.0_f32, -1.0, 0.5, 0.5], 2, &mut output);
        assert_eq!(output, vec![0.0, 0.5]);
    }

    #[test]
    fn resamples_common_windows_rate_to_whisper_rate() {
        let input = vec![0.25_f32; 48_000];
        let output = resample_linear(&input, 48_000, 16_000);
        assert_eq!(output.len(), 16_000);
        assert!(output
            .iter()
            .all(|sample| (*sample - 0.25).abs() < f32::EPSILON));
    }
}
