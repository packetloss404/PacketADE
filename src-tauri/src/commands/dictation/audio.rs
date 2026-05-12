use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::models::AudioDevice;

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
}

/// Create the managed `DictationState` — call this once at app startup.
pub fn create_dictation_state() -> DictationState {
    DictationState {
        buffer: Arc::new(Mutex::new(Vec::new())),
        is_recording: Arc::new(AtomicBool::new(false)),
        stream: Arc::new(Mutex::new(None)),
        emitter_running: Arc::new(AtomicBool::new(false)),
    }
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct WaveformPayload {
    bars: Vec<f32>,
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    status: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Return the list of available audio input devices.
#[tauri::command]
pub fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();

    let default_device_name = host.default_input_device().and_then(|d| d.name().ok());

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?;

    let mut result: Vec<AudioDevice> = Vec::new();
    for (idx, device) in devices.enumerate() {
        let name = device.name().unwrap_or_else(|_| format!("Device {}", idx));
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
/// Opens a 16 kHz mono f32 input stream, appends samples to the shared
/// buffer, and spawns a thread that computes a 512-point FFT every ~33 ms
/// to emit 25 exponential frequency bars via the `dictation:waveform` event.
#[tauri::command]
pub fn start_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, DictationState>,
    device_index: Option<u32>,
) -> Result<(), String> {
    if state.is_recording.load(Ordering::SeqCst) {
        return Err("Already recording".to_string());
    }

    let host = cpal::default_host();

    // Pick the device ---------------------------------------------------
    let device = if let Some(idx) = device_index {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .nth(idx as usize)
            .ok_or_else(|| format!("No input device at index {}", idx))?
    } else {
        host.default_input_device()
            .ok_or_else(|| "No default input device available".to_string())?
    };

    // Configure stream --------------------------------------------------
    let config = cpal::StreamConfig {
        channels: 1,
        sample_rate: 16_000,
        buffer_size: cpal::BufferSize::Default,
    };

    // Shared buffer for cpal callback → FFT thread
    let buf = Arc::clone(&state.buffer);
    {
        let mut b = buf.lock().map_err(|e| e.to_string())?;
        b.clear();
    }

    let buf_writer = Arc::clone(&buf);
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut b) = buf_writer.lock() {
                    b.extend_from_slice(data);
                }
            },
            |err| {
                tracing::error!("cpal input stream error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {}", e))?;

    // Store stream handle so we can stop it later -----------------------
    {
        let mut s = state.stream.lock().map_err(|e| e.to_string())?;
        *s = Some(stream);
    }

    state.is_recording.store(true, Ordering::SeqCst);
    state.emitter_running.store(true, Ordering::SeqCst);

    // Spawn waveform emitter thread -------------------------------------
    let emitter_buf = Arc::clone(&buf);
    let emitter_running = Arc::clone(&state.emitter_running);
    let handle = app_handle.clone();

    std::thread::spawn(move || {
        const FFT_SIZE: usize = 512;
        const NUM_BARS: usize = 25;
        const RMS_THRESHOLD: f32 = 0.08;
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

        while emitter_running.load(Ordering::SeqCst) {
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
                let _ = handle.emit("dictation:waveform", WaveformPayload { bars });
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

            let _ = handle.emit("dictation:waveform", WaveformPayload { bars });
        }
    });

    Ok(())
}

/// Stop recording and return the raw audio buffer.
///
/// Emits a `dictation:status` event with `"transcribing"` so the UI can
/// show a spinner while the whisper module processes the audio.
#[tauri::command]
pub fn stop_recording(
    app_handle: AppHandle,
    state: tauri::State<'_, DictationState>,
) -> Result<Vec<f32>, String> {
    if !state.is_recording.load(Ordering::SeqCst) {
        return Err("Not currently recording".to_string());
    }

    // Signal the emitter thread to stop
    state.emitter_running.store(false, Ordering::SeqCst);

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

    // Notify the frontend
    let _ = app_handle.emit(
        "dictation:status",
        StatusPayload {
            status: "transcribing".to_string(),
        },
    );

    Ok(audio)
}
