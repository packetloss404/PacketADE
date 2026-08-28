use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use rustfft::{num_complex::Complex, FftPlanner};
use tauri::{AppHandle, Emitter};

use super::{
    history, models,
    models::{AudioDevice, AudioDeviceTestResult, DictationResult},
    whisper,
};

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
    /// Transcript-free metadata for the active capture.
    capture_info: Arc<Mutex<Option<CaptureInfo>>>,
    /// Set by the cpal error callback when the device dies mid-capture (a
    /// Bluetooth headset leaving range, powering off, or switching profile).
    /// The callback runs on the audio thread that `Stream::drop` joins, so it
    /// cannot release the stream itself; it leaves this breadcrumb and lets
    /// `stop_recording` / `cancel_recording` / `start_recording` reap it.
    capture_error: Arc<Mutex<Option<String>>>,
    /// Frames handed to us by cpal during the active capture. Only ever
    /// compared against itself: the waveform thread watches it stop advancing
    /// to detect a device that has gone quiet without raising a stream error.
    frames_captured: Arc<AtomicU64>,
}

#[derive(Clone)]
struct CaptureInfo {
    device_name: String,
    device_id: Option<String>,
    channels: u16,
    sample_format: String,
    warnings: Vec<String>,
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
        capture_info: Arc::new(Mutex::new(None)),
        capture_error: Arc::new(Mutex::new(None)),
        frames_captured: Arc::new(AtomicU64::new(0)),
    }
}

/// Waveform-thread ticks without a new cpal frame before a capture counts as
/// stalled rather than jittery. The emitter ticks every 33 ms, so this is
/// roughly two seconds — far beyond WASAPI's ~10 ms shared-mode cadence, and
/// beyond the pause a Bluetooth link can absorb and recover from.
const STALL_TICKS: u32 = 60;

/// Watches the cpal frame counter for a device that has stopped delivering
/// audio *without* raising a stream error.
///
/// A Bluetooth headset that loses its link or switches profile does not always
/// take the error-callback path on WASAPI; it can simply go quiet, in which
/// case nothing downstream notices until the user releases the key and gets an
/// empty transcript. Counting frames rather than reading a clock keeps the
/// audio callback free of timing calls. This also catches the never-started
/// case (OS microphone privacy block, failed Bluetooth handshake), where the
/// counter sits at zero from the first tick.
struct StallWatch {
    last_frames: u64,
    quiet_ticks: u32,
    reported: bool,
}

impl StallWatch {
    fn new() -> Self {
        Self {
            last_frames: 0,
            quiet_ticks: 0,
            reported: false,
        }
    }

    /// Feed the current frame count once per emitter tick. Returns true only on
    /// the single tick where the capture first qualifies as stalled, so the
    /// caller emits one notice rather than one every 33 ms.
    fn observe(&mut self, frames: u64) -> bool {
        if frames != self.last_frames {
            self.last_frames = frames;
            self.quiet_ticks = 0;
            return false;
        }
        if self.reported {
            return false;
        }
        self.quiet_ticks = self.quiet_ticks.saturating_add(1);
        if self.quiet_ticks >= STALL_TICKS {
            self.reported = true;
            return true;
        }
        false
    }
}

/// Whisper's front end needs a real utterance. Below this the encoder either
/// rejects the buffer outright or answers a fumbled push-to-talk tap with a
/// confident hallucination ("Thank you.", "Bye."), which is worse than saying
/// nothing. 250 ms at 16 kHz is well under the shortest real word and well
/// over a sub-frame capture.
const MIN_TRANSCRIBABLE_SAMPLES: usize = 4_000;

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

    let default_device_id = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {}", e))?;

    let mut result: Vec<AudioDevice> = Vec::new();
    for (idx, device) in devices.enumerate() {
        let name = device
            .description()
            .map(|desc| desc.name().to_string())
            .unwrap_or_else(|_| format!("Device {}", idx));
        let id = device.id().ok().map(|id| id.to_string());
        let is_default = default_device_id
            .as_ref()
            .zip(id.as_ref())
            .map(|(default_id, id)| default_id == id)
            .unwrap_or(false);
        let (sample_rate, channels, sample_format) = device
            .default_input_config()
            .map(|config| {
                (
                    Some(config.sample_rate()),
                    Some(config.channels()),
                    Some(config.sample_format().to_string()),
                )
            })
            .unwrap_or((None, None, None));
        result.push(AudioDevice {
            index: idx as u32,
            id,
            name,
            is_default,
            sample_rate,
            channels,
            sample_format,
        });
    }

    Ok(result)
}

struct DeviceSelection {
    device: cpal::Device,
    warning: Option<String>,
}

fn select_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
    device_index: Option<u32>,
) -> Result<DeviceSelection, String> {
    if let Some(raw_id) = device_id.filter(|id| !id.trim().is_empty()) {
        match raw_id.parse::<cpal::DeviceId>() {
            Ok(id) => {
                if let Some(device) = host.device_by_id(&id) {
                    return Ok(DeviceSelection {
                        device,
                        warning: None,
                    });
                }
            }
            Err(error) => {
                tracing::warn!(device_id = raw_id, %error, "Saved microphone identity is invalid");
            }
        }

        let device = host.default_input_device().ok_or_else(|| {
            "The selected microphone is unavailable and no default input device exists".to_string()
        })?;
        return Ok(DeviceSelection {
            device,
            warning: Some(
                "The saved microphone is unavailable; using the current default microphone."
                    .to_string(),
            ),
        });
    }

    if let Some(index) = device_index {
        if let Some(device) = host
            .input_devices()
            .map_err(|error| format!("Failed to enumerate devices: {error}"))?
            .nth(index as usize)
        {
            return Ok(DeviceSelection {
                device,
                warning: Some(
                    "Migrated a legacy microphone index. Re-save the device to use its stable identity."
                        .to_string(),
                ),
            });
        }

        let device = host.default_input_device().ok_or_else(|| {
            format!(
                "Legacy microphone index {index} is unavailable and no default input device exists"
            )
        })?;
        return Ok(DeviceSelection {
            device,
            warning: Some(format!(
                "Legacy microphone index {index} is unavailable; using the current default microphone."
            )),
        });
    }

    host.default_input_device()
        .map(|device| DeviceSelection {
            device,
            warning: None,
        })
        .ok_or_else(|| {
            "No default input device is available. Connect or enable a microphone in system sound settings."
                .to_string()
        })
}

#[derive(Default)]
struct ProbeStats {
    frames: u64,
    sum_squares: f64,
    peak: f32,
}

/// Briefly opens a microphone and returns signal/format diagnostics. Captured
/// samples are reduced to counters in the callback and are never retained.
#[tauri::command]
pub async fn test_audio_device(
    device_id: Option<String>,
    device_index: Option<u32>,
    duration_ms: Option<u64>,
) -> Result<AudioDeviceTestResult, String> {
    let duration_ms = duration_ms.unwrap_or(1_500).clamp(500, 3_000);
    tokio::task::spawn_blocking(move || {
        run_audio_device_test(device_id.as_deref(), device_index, duration_ms)
    })
    .await
    .map_err(|error| format!("Microphone test task failed: {error}"))?
}

fn run_audio_device_test(
    device_id: Option<&str>,
    device_index: Option<u32>,
    duration_ms: u64,
) -> Result<AudioDeviceTestResult, String> {
    let host = cpal::default_host();
    let selection = select_input_device(&host, device_id, device_index)?;
    let device = selection.device;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("Could not read the microphone format: {error}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = usize::from(config.channels);
    let stats = Arc::new(Mutex::new(ProbeStats::default()));
    let stream_error = Arc::new(Mutex::new(None::<String>));

    let stream = match sample_format {
        SampleFormat::I8 => {
            build_probe_stream::<i8>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::I16 => {
            build_probe_stream::<i16>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::I24 => {
            build_probe_stream::<cpal::I24>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::I32 => {
            build_probe_stream::<i32>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::I64 => {
            build_probe_stream::<i64>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::U8 => {
            build_probe_stream::<u8>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::U16 => {
            build_probe_stream::<u16>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::U24 => {
            build_probe_stream::<cpal::U24>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::U32 => {
            build_probe_stream::<u32>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::U64 => {
            build_probe_stream::<u64>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::F32 => {
            build_probe_stream::<f32>(&device, &config, channels, &stats, &stream_error)
        }
        SampleFormat::F64 => {
            build_probe_stream::<f64>(&device, &config, channels, &stats, &stream_error)
        }
        unsupported => Err(format!(
            "Microphone sample format '{unsupported}' is not supported for diagnostics"
        )),
    }?;

    stream
        .play()
        .map_err(|error| format!("Could not start the microphone test: {error}"))?;
    std::thread::sleep(Duration::from_millis(duration_ms));
    drop(stream);

    if let Some(error) = stream_error
        .lock()
        .map_err(|error| error.to_string())?
        .take()
    {
        return Err(error);
    }
    let stats = stats.lock().map_err(|error| error.to_string())?;
    if stats.frames == 0 {
        return Err(
            "The microphone opened but delivered no audio frames. Check OS microphone privacy and input-device settings."
                .to_string(),
        );
    }
    let rms = (stats.sum_squares / stats.frames as f64).sqrt() as f32;
    let name = device
        .description()
        .map(|description| description.name().to_string())
        .unwrap_or_else(|_| "Unknown microphone".to_string());
    let warning = selection.warning.or_else(|| {
        (stats.peak < 0.001).then(|| {
            "The microphone is connected but the signal is nearly silent. Check mute and input gain."
                .to_string()
        })
    });

    Ok(AudioDeviceTestResult {
        device_id: device.id().ok().map(|id| id.to_string()),
        name,
        sample_rate: config.sample_rate,
        channels: config.channels,
        sample_format: sample_format.to_string(),
        captured_frames: stats.frames,
        duration_ms,
        peak_level: stats.peak,
        rms_level: rms,
        warning,
    })
}

fn build_probe_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    stats: &Arc<Mutex<ProbeStats>>,
    stream_error: &Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    let stats = Arc::clone(stats);
    let stream_error = Arc::clone(stream_error);
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if let Ok(mut stats) = stats.lock() {
                    for frame in data.chunks_exact(channels.max(1)) {
                        let mono = frame.iter().copied().map(f32::from_sample).sum::<f32>()
                            / channels.max(1) as f32;
                        let mono = mono.clamp(-1.0, 1.0);
                        stats.frames += 1;
                        stats.sum_squares += f64::from(mono * mono);
                        stats.peak = stats.peak.max(mono.abs());
                    }
                }
            },
            move |error| {
                if let Ok(mut target) = stream_error.lock() {
                    *target = Some(format!(
                        "Microphone test stream stopped unexpectedly: {error}"
                    ));
                }
            },
            None,
        )
        .map_err(|error| format!("Could not build the microphone test stream: {error}"))
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
    device_id: Option<String>,
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

    // A capture that died inside its cpal error callback could not drop its own
    // stream, so the handle may still be holding the microphone open. Reap the
    // orphan before we try to open a device again — otherwise a Bluetooth
    // headset that has come back into range is opened a second time while the
    // dead handle still owns it.
    {
        let mut stale = state.stream.lock().map_err(|e| e.to_string())?;
        if stale.take().is_some() {
            tracing::warn!("Released a microphone stream left open by a failed capture");
        }
    }
    *state.capture_error.lock().map_err(|e| e.to_string())? = None;

    // Teardown (`stop_recording` / `cancel_recording`) bumps the generation
    // while holding the stream lock, so comparing against this value under the
    // same lock later tells us whether this start was superseded while the
    // device was still opening. Bluetooth devices take hundreds of milliseconds
    // to open, which is more than enough time for a cancel to land.
    let start_generation = state.recording_generation.load(Ordering::SeqCst);

    let host = cpal::default_host();
    let settings = super::config::read_dictation_config()?;
    // Fail before opening the microphone instead of after the user has spoken.
    models::resolve_verified_model(&settings.model_size)?;

    // Pick the device ---------------------------------------------------
    let selection = select_input_device(
        &host,
        device_id.as_deref().or(settings.device_id.as_deref()),
        device_index.or(settings.device_index),
    )?;
    let device = selection.device;

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
    let selected_device_id = device.id().ok().map(|id| id.to_string());
    let mut capture_warnings = Vec::new();
    if let Some(warning) = selection.warning {
        tracing::warn!(%warning, "Dictation microphone selection recovered");
        let _ = app_handle.emit("dictation:warning", warning.clone());
        capture_warnings.push(warning);
    }
    tracing::info!(
        device = %device_name,
        sample_rate,
        channels,
        sample_format = ?sample_format,
        "Starting dictation capture"
    );

    // Shared buffer for cpal callback → FFT thread
    let buf = Arc::clone(&state.buffer);
    {
        let mut b = buf.lock().map_err(|e| e.to_string())?;
        *b = Vec::new();
    }
    state.frames_captured.store(0, Ordering::SeqCst);
    let max_samples = (sample_rate as usize)
        .saturating_mul(settings.max_duration_seconds as usize)
        .max(sample_rate as usize);

    let stream = match sample_format {
        SampleFormat::I8 => build_input_stream::<i8>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::I16 => build_input_stream::<i16>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::I24 => build_input_stream::<cpal::I24>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::I32 => build_input_stream::<i32>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::I64 => build_input_stream::<i64>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::U8 => build_input_stream::<u8>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::U16 => build_input_stream::<u16>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::U24 => build_input_stream::<cpal::U24>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::U32 => build_input_stream::<u32>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::U64 => build_input_stream::<u64>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::F32 => build_input_stream::<f32>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        SampleFormat::F64 => build_input_stream::<f64>(
            &device,
            &config,
            channels,
            Arc::clone(&buf),
            &state,
            &app_handle,
            max_samples,
        ),
        unsupported => Err(format!(
            "Microphone sample format '{unsupported}' is not supported for dictation"
        )),
    }?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {}", e))?;

    // Publish the stream and its bookkeeping atomically with respect to
    // `stop_recording` / `cancel_recording`, which bump the generation under
    // this same lock. Without the guard, a stop or cancel that lands while a
    // slow (Bluetooth) device is still opening tears down an empty slot and
    // this thread then installs a live stream nobody owns: the microphone
    // stays hot, the waveform thread runs forever, and the UI reads "idle".
    let generation = {
        let mut slot = state.stream.lock().map_err(|e| e.to_string())?;
        if state.recording_generation.load(Ordering::SeqCst) != start_generation {
            drop(slot);
            // Dropping the stream outside the lock releases the device without
            // holding the mutex across cpal's audio-thread join. Commit the
            // guard deliberately: the stop/cancel that superseded us already
            // cleared `is_recording`, and a newer capture may now own it.
            drop(stream);
            start_guard.commit();
            return Err("Recording was stopped before the microphone finished opening".to_string());
        }
        state.sample_rate.store(sample_rate, Ordering::SeqCst);
        *slot = Some(stream);
        state.emitter_running.store(true, Ordering::SeqCst);
        state.recording_generation.fetch_add(1, Ordering::SeqCst) + 1
    };

    *state.started_at.lock().map_err(|e| e.to_string())? = Some(Instant::now());
    *state.capture_info.lock().map_err(|e| e.to_string())? = Some(CaptureInfo {
        device_name,
        device_id: selected_device_id,
        channels: config.channels,
        sample_format: sample_format.to_string(),
        warnings: capture_warnings,
    });
    start_guard.commit();

    // Spawn waveform emitter thread -------------------------------------
    let emitter_buf = Arc::clone(&buf);
    let emitter_running = Arc::clone(&state.emitter_running);
    let active_generation = Arc::clone(&state.recording_generation);
    let emitter_frames = Arc::clone(&state.frames_captured);
    let emitter_capture_error = Arc::clone(&state.capture_error);
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

        let mut stall_watch = StallWatch::new();

        while emitter_running.load(Ordering::SeqCst)
            && active_generation.load(Ordering::SeqCst) == generation
        {
            std::thread::sleep(FRAME_INTERVAL);

            // Checked before the buffer-length guard below, because the
            // never-delivered-a-frame case never fills the buffer at all.
            if stall_watch.observe(emitter_frames.load(Ordering::Relaxed)) {
                const STALL_NOTICE: &str =
                    "The microphone stopped delivering audio. A Bluetooth headset may have dropped its link or switched profile.";
                tracing::warn!("Dictation capture stalled: no cpal frames for ~2s");
                // Deliberately a warning, not `dictation:error`. A stall is not
                // a confirmed disconnect and it can recover, whereas the error
                // path tears the capture down and discards everything already
                // spoken. Recording it here also carries the explanation onto
                // the result's `warnings` when the user releases the key.
                if let Ok(mut slot) = emitter_capture_error.lock() {
                    if slot.is_none() {
                        *slot = Some(STALL_NOTICE.to_string());
                    }
                }
                let _ = handle.emit("dictation:warning", STALL_NOTICE);
            }

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
    whisper_state: tauri::State<'_, whisper::WhisperState>,
) -> Result<(), String> {
    let was_recording = state.is_recording.swap(false, Ordering::SeqCst);

    // Escape during *transcription* has to abandon the whisper run as well as
    // the capture. Without this the run finishes to completion and its text
    // lands in a field the user has already moved on from. Bumping the epoch
    // when nothing is in flight is harmless: the next `begin_run` claims a
    // newer token regardless, so this cannot cancel a future capture.
    whisper_state.cancel();

    // Bump the generation while holding the stream lock so a `start_recording`
    // that is still opening a slow device sees the cancel and abandons its
    // stream instead of installing one this teardown can never reach.
    {
        let mut stream = state.stream.lock().map_err(|e| e.to_string())?;
        state.emitter_running.store(false, Ordering::SeqCst);
        state.recording_generation.fetch_add(1, Ordering::SeqCst);
        *stream = None;
    }
    {
        let mut buffer = state.buffer.lock().map_err(|e| e.to_string())?;
        *buffer = Vec::new();
    }
    *state.started_at.lock().map_err(|e| e.to_string())? = None;
    *state.capture_info.lock().map_err(|e| e.to_string())? = None;
    *state.capture_error.lock().map_err(|e| e.to_string())? = None;
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
) -> Result<DictationResult, String> {
    // A capture killed by its own error callback has already cleared
    // `is_recording`. Treat that as a stoppable capture instead of rejecting
    // the user's key release with "Not currently recording" and stranding the
    // words they already spoke in a buffer nothing will ever read.
    let was_recording = state.is_recording.swap(false, Ordering::SeqCst);
    let capture_error = state
        .capture_error
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    if !was_recording && capture_error.is_none() {
        return Err("Not currently recording".to_string());
    }

    // Signal the emitter thread to stop and drop the cpal stream (which stops
    // recording and releases the device). The generation bump happens under
    // the stream lock so a concurrent `start_recording` cannot install a
    // stream behind this teardown.
    {
        let mut s = state.stream.lock().map_err(|e| e.to_string())?;
        state.emitter_running.store(false, Ordering::SeqCst);
        state.recording_generation.fetch_add(1, Ordering::SeqCst);
        *s = None;
    }

    // Grab the full buffer
    let audio = {
        let mut b = state.buffer.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *b)
    };
    let input_sample_rate = state.sample_rate.load(Ordering::SeqCst);
    let captured_samples = audio.len();
    let audio = resample_linear(&audio, input_sample_rate, 16_000);
    let duration_seconds = effective_duration_seconds(
        state
            .started_at
            .lock()
            .map_err(|e| e.to_string())?
            .take()
            .map(|started| started.elapsed().as_secs_f64()),
        captured_samples,
        input_sample_rate,
    );
    let mut capture_info = state
        .capture_info
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .unwrap_or(CaptureInfo {
            device_name: "Unknown microphone".to_string(),
            device_id: None,
            channels: 1,
            sample_format: "unknown".to_string(),
            warnings: vec!["Capture metadata was unavailable.".to_string()],
        });
    if let Some(error) = capture_error {
        // Surfaced as a warning rather than an error: the audio recorded
        // before the device vanished is worth more to the user than a clean
        // failure, so we still transcribe whatever we have.
        capture_info.warnings.push(error);
    }

    let settings = super::config::read_dictation_config()?;

    if audio.len() < MIN_TRANSCRIBABLE_SAMPLES {
        // Push-to-talk taps that end before the device produced audio, and
        // captures cut off in their first moments, land here. Returning an
        // empty result with an explanation beats both Whisper's bare "No audio
        // data to transcribe" and a hallucinated phrase.
        capture_info.warnings.push(
            "The capture was too short to transcribe. Hold the dictation key until the waveform moves."
                .to_string(),
        );
        return Ok(DictationResult {
            text: String::new(),
            duration_seconds,
            input_sample_rate,
            channels: capture_info.channels,
            sample_format: capture_info.sample_format,
            device_name: capture_info.device_name,
            device_id: capture_info.device_id,
            model_size: settings.model_size,
            detected_language: None,
            model_load_ms: 0,
            inference_ms: 0,
            warnings: capture_info.warnings,
        });
    }

    // Notify the frontend
    let _ = app_handle.emit("dictation:status", "transcribing");

    let (model_size, model_path) = models::resolve_verified_model(&settings.model_size)?;
    let model_path = model_path.to_string_lossy().to_string();
    let whisper_state = (*whisper_state).clone();
    let language = settings.language;
    let custom_dictionary = settings.custom_dictionary;

    let outcome = tokio::task::spawn_blocking(move || {
        whisper::transcribe_audio(
            &whisper_state,
            audio,
            &model_path,
            &language,
            &custom_dictionary,
        )
    })
    .await
    .map_err(|e| format!("Transcription task failed: {e}"))??;

    if outcome.cancelled {
        // A cancel landed while whisper was mid-encode. `text` is empty either
        // way, so this is only about the result describing itself: without it a
        // deliberate Escape is indistinguishable from the model hearing silence.
        capture_info
            .warnings
            .push("Transcription was cancelled.".to_string());
    }

    if !outcome.text.trim().is_empty() {
        let word_count = outcome.text.split_whitespace().count() as i64;
        let wpm = duration_seconds
            .filter(|duration| *duration > 0.0)
            .map(|duration| ((word_count as f64 / duration) * 60.0).round() as i64);
        if let Err(err) = history::insert_entry(
            &outcome.text,
            "transcribe",
            duration_seconds,
            Some(word_count),
            wpm,
        ) {
            // History is secondary to delivery. A locked/corrupt analytics DB
            // must not discard a successful local transcription.
            tracing::warn!("Failed to save dictation history entry: {err}");
        }
    }

    Ok(DictationResult {
        text: outcome.text,
        duration_seconds,
        input_sample_rate,
        channels: capture_info.channels,
        sample_format: capture_info.sample_format,
        device_name: capture_info.device_name,
        device_id: capture_info.device_id,
        model_size,
        detected_language: outcome.detected_language,
        model_load_ms: outcome.model_load_ms,
        inference_ms: outcome.inference_ms,
        warnings: capture_info.warnings,
    })
}

fn build_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    buffer: Arc<Mutex<Vec<f32>>>,
    state: &tauri::State<'_, DictationState>,
    app_handle: &AppHandle,
    max_samples: usize,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    let is_recording = Arc::clone(&state.is_recording);
    let emitter_running = Arc::clone(&state.emitter_running);
    let capture_error = Arc::clone(&state.capture_error);
    let frames_captured = Arc::clone(&state.frames_captured);
    let error_handle = app_handle.clone();
    let limit_handle = app_handle.clone();
    let limit_notified = Arc::new(AtomicBool::new(false));
    let callback_limit_notified = Arc::clone(&limit_notified);

    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                // Counted before the lock and regardless of the capture
                // ceiling: this records that the *device* is still alive, which
                // is a different question from whether we still want its audio.
                frames_captured.fetch_add(1, Ordering::Relaxed);
                if let Ok(mut target) = buffer.lock() {
                    let limit_reached =
                        append_mono_samples_bounded(data, channels, &mut target, max_samples);
                    if limit_reached && !callback_limit_notified.swap(true, Ordering::SeqCst) {
                        let _ = limit_handle.emit("dictation:limit-reached", ());
                    }
                }
            },
            move |err| {
                tracing::error!("cpal input stream error: {err}");
                let message = format!("Microphone stream stopped unexpectedly: {err}");
                // Record the failure before clearing `is_recording`, so a
                // `stop_recording` racing this callback always finds either a
                // live capture or the reason it died — never neither. Keep the
                // first error: a disconnect typically cascades into follow-ups
                // that describe the symptom rather than the cause.
                if let Ok(mut slot) = capture_error.lock() {
                    if slot.is_none() {
                        *slot = Some(message.clone());
                    }
                }
                is_recording.store(false, Ordering::SeqCst);
                emitter_running.store(false, Ordering::SeqCst);
                let _ = error_handle.emit("dictation:error", message);
            },
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {e}"))
}

fn append_mono_samples_bounded<T>(
    input: &[T],
    channels: usize,
    output: &mut Vec<f32>,
    max_samples: usize,
) -> bool
where
    T: Copy,
    f32: FromSample<T>,
{
    if output.len() >= max_samples {
        return true;
    }
    let remaining = max_samples - output.len();
    let channels = channels.max(1);
    output.reserve((input.len() / channels).min(remaining));
    for frame in input.chunks_exact(channels).take(remaining) {
        let sum = frame.iter().copied().map(f32::from_sample).sum::<f32>();
        output.push((sum / channels as f32).clamp(-1.0, 1.0));
    }
    output.len() >= max_samples
}

/// Wall-clock hold time overstates a capture that cpal cut short — device loss
/// mid-hold, or the buffer hitting its ceiling — and that inflated denominator
/// then lands in the history table as a bogus words-per-minute figure. Never
/// report more time than we actually have audio for.
fn effective_duration_seconds(
    wall_clock_seconds: Option<f64>,
    captured_samples: usize,
    sample_rate: u32,
) -> Option<f64> {
    let wall_clock = wall_clock_seconds?;
    if sample_rate == 0 {
        return Some(wall_clock);
    }
    let captured = captured_samples as f64 / f64::from(sample_rate);
    Some(wall_clock.min(captured))
}

/// Convert a device-rate mono buffer to Whisper's 16 kHz.
///
/// Downsampling (the 44.1/48 kHz case that covers nearly every Windows
/// microphone) and upsampling (the 8/16 kHz a Bluetooth hands-free profile
/// forces) take different paths — see the comment on the decimation branch for
/// why point-sampling alone is not safe here.
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

    if step > 1.0 {
        // Decimation. Picking every Nth sample folds every component above the
        // output's 8 kHz Nyquist back into the speech band, so sibilance, fan
        // noise and switching whine arrive at Whisper as plausible-sounding
        // low-frequency energy — which is how a capture that sounds fine comes
        // back as fluent, confidently wrong words. Averaging each output
        // period first is a box low-pass whose first null sits on the output
        // rate: not a polyphase FIR, and honestly weak right at the band edge
        // (~4.6 dB at 9 kHz), but it climbs past 9.5 dB above 12 kHz and peaks
        // near 35 dB at 16 kHz, all at unity DC gain for a handful of adds.
        // `downsampling_attenuates_the_whole_alias_band` pins those numbers.
        let half_window = step / 2.0;
        for index in 0..output_len {
            let centre = index as f64 * step;
            let start = ((centre - half_window).round().max(0.0) as usize).min(input.len() - 1);
            let end = (((centre + half_window).round() as usize).max(start + 1)).min(input.len());
            let window = &input[start..end];
            output.push(window.iter().sum::<f32>() / window.len() as f32);
        }
    } else {
        // Interpolation. Nothing to alias when the output rate is the higher
        // of the two, so linear interpolation between neighbours is enough.
        for index in 0..output_len {
            let position = index as f64 * step;
            let left = (position.floor() as usize).min(input.len() - 1);
            let right = (left + 1).min(input.len() - 1);
            let fraction = (position - left as f64) as f32;
            output.push(input[left] + (input[right] - input[left]) * fraction);
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmixes_interleaved_stereo_audio() {
        let mut output = Vec::new();
        append_mono_samples_bounded(&[1.0_f32, -1.0, 0.5, 0.5], 2, &mut output, usize::MAX);
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

    #[test]
    fn bounded_capture_never_exceeds_its_limit() {
        let mut output = vec![0.25_f32; 2];
        let reached = append_mono_samples_bounded(&[1.0_f32, -1.0, 0.5, 0.5], 2, &mut output, 3);
        assert!(reached);
        assert_eq!(output, vec![0.25, 0.25, 0.0]);

        let reached_again = append_mono_samples_bounded(&[0.75_f32, 0.75], 2, &mut output, 3);
        assert!(reached_again);
        assert_eq!(output.len(), 3);
    }

    #[test]
    fn treats_a_zero_channel_config_as_mono() {
        // A device that reports zero channels must not divide by zero or drop
        // every frame; the hands-free Bluetooth profile is already a 1-channel
        // edge case and this is the degenerate neighbour.
        let mut output = Vec::new();
        append_mono_samples_bounded(&[0.5_f32, -0.5], 0, &mut output, usize::MAX);
        assert_eq!(output, vec![0.5, -0.5]);
    }

    #[test]
    fn capture_limit_latches_exactly_at_the_boundary() {
        let mut output = Vec::new();
        let reached = append_mono_samples_bounded(&[0.1_f32, 0.2, 0.3, 0.4], 1, &mut output, 4);
        assert!(reached, "reaching the ceiling must report the limit");
        assert_eq!(output.len(), 4);

        // One frame short of the ceiling must not fire `dictation:limit-reached`.
        let mut output = Vec::new();
        let reached = append_mono_samples_bounded(&[0.1_f32, 0.2, 0.3], 1, &mut output, 4);
        assert!(!reached);
        assert_eq!(output.len(), 3);
    }

    #[test]
    fn resamples_441_khz_capture_to_whisper_rate() {
        let input = vec![0.5_f32; 44_100];
        let output = resample_linear(&input, 44_100, 16_000);
        assert_eq!(output.len(), 16_000);
        assert!(output.iter().all(|sample| (*sample - 0.5).abs() < 1e-6));
    }

    #[test]
    fn upsamples_narrowband_hands_free_capture_to_whisper_rate() {
        // A Bluetooth headset that has switched to hands-free hands us 8 kHz.
        let input: Vec<f32> = (0..8_000).map(|i| (i as f32 / 8_000.0) - 0.5).collect();
        let output = resample_linear(&input, 8_000, 16_000);
        assert_eq!(output.len(), 16_000);
        assert!((output[0] - input[0]).abs() < 1e-6);
        assert!(output.iter().all(|sample| (-0.51..=0.51).contains(sample)));
    }

    /// The pre-fix resampler: linear interpolation, which at the integer
    /// 48 kHz -> 16 kHz step has a fraction of exactly zero and so degenerates
    /// into taking every third frame. Kept here so the tests below can show
    /// they actually distinguish the two implementations.
    fn point_sampled_reference(input: &[f32], input_rate: u32, output_rate: u32) -> Vec<f32> {
        let output_len =
            ((input.len() as f64 * output_rate as f64 / input_rate as f64).round() as usize).max(1);
        let step = input_rate as f64 / output_rate as f64;
        (0..output_len)
            .map(|index| {
                let position = index as f64 * step;
                let left = (position.floor() as usize).min(input.len() - 1);
                let right = (left + 1).min(input.len() - 1);
                let fraction = (position - left as f64) as f32;
                input[left] + (input[right] - input[left]) * fraction
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples
            .iter()
            .map(|s| f64::from(*s) * f64::from(*s))
            .sum::<f64>()
            / samples.len() as f64)
            .sqrt()
    }

    fn attenuation_db(input: &[f32], output: &[f32]) -> f64 {
        20.0 * (rms(output).max(1e-12) / rms(input)).log10()
    }

    /// A tone sampled at 48 kHz, with a deliberate phase offset: a *zero*-phase
    /// 16 kHz tone lands exactly on the zero crossings of every third frame, so
    /// point sampling returns pure silence and any single-tone test built on it
    /// would pass against the broken resampler. That trap is why the sweep
    /// below never relies on one frequency alone.
    fn tone_48k(frequency: f64, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| {
                ((2.0 * std::f64::consts::PI * frequency * i as f64 / 48_000.0) + 0.3).sin() as f32
            })
            .collect()
    }

    #[test]
    fn downsampling_rejects_content_above_the_output_nyquist() {
        // A 16 kHz component in a 48 kHz capture, as a square-ish wave rather
        // than a sine so it does not sit on the point-sampling null described
        // on `tone_48k`. The box low-pass nulls exactly this period.
        let input: Vec<f32> = (0..48_000)
            .map(|i| if i % 3 == 0 { 1.0 } else { -0.5 })
            .collect();
        let output = resample_linear(&input, 48_000, 16_000);
        assert_eq!(output.len(), 16_000);
        // Index 0 sits on a half window at the buffer edge; the steady state is
        // what matters.
        assert!(
            output[1..].iter().all(|sample| sample.abs() < 1e-6),
            "aliased component survived resampling"
        );
        // Prove the assertion above actually discriminates: the old resampler
        // folded this straight onto DC at full scale.
        let reference = point_sampled_reference(&input, 48_000, 16_000);
        assert!(
            reference[1..]
                .iter()
                .all(|sample| (*sample - 1.0).abs() < 1e-6),
            "reference must show the defect this test guards against"
        );
    }

    #[test]
    fn downsampling_attenuates_the_whole_alias_band() {
        // One tone at the filter's own null proves little on its own, so sweep
        // the entire band that folds back into Whisper's input: everything
        // above the 8 kHz output Nyquist, up to the 24 kHz input Nyquist.
        let mut weakest_upper_band = f64::MIN;
        for step in 0..=60 {
            let frequency = 9_000.0 + f64::from(step) * 250.0;
            let tone = tone_48k(frequency, 4_800);
            let filtered = attenuation_db(&tone, &resample_linear(&tone, 48_000, 16_000));
            let reference = attenuation_db(&tone, &point_sampled_reference(&tone, 48_000, 16_000));

            assert!(
                filtered <= -4.0,
                "{frequency} Hz aliased through at only {filtered:.2} dB"
            );
            assert!(
                filtered <= reference - 3.0,
                "{frequency} Hz: box filter {filtered:.2} dB is no better than point sampling {reference:.2} dB"
            );
            if frequency >= 12_000.0 {
                weakest_upper_band = weakest_upper_band.max(filtered);
            }
        }
        // Near the 8 kHz edge a single box average can only manage about 4.6 dB
        // — the honest limit of this approach, and why the comment on
        // `resample_linear` does not promise more. Above 12 kHz it bites.
        assert!(
            weakest_upper_band <= -9.0,
            "weakest attenuation above 12 kHz was {weakest_upper_band:.2} dB"
        );
    }

    #[test]
    fn sub_frame_captures_resample_without_panicking() {
        // Fast push-to-talk: press and release before the device delivers a
        // full frame. None of these may panic on the slice arithmetic.
        assert!(resample_linear(&[], 48_000, 16_000).is_empty());
        assert_eq!(resample_linear(&[0.5], 48_000, 16_000), vec![0.5]);
        assert_eq!(resample_linear(&[0.5, 0.25], 48_000, 16_000).len(), 1);
        assert!(resample_linear(&[0.5, 0.25], 0, 16_000).is_empty());
        assert!(resample_linear(&[0.5, 0.25], 48_000, 0).is_empty());
    }

    #[test]
    fn short_capture_floor_separates_taps_from_utterances() {
        assert_eq!(MIN_TRANSCRIBABLE_SAMPLES, 16_000 / 4);

        // A 40 ms push-to-talk tap on a 48 kHz device is below the floor.
        let tap = vec![0.1_f32; 48_000 / 25];
        assert!(resample_linear(&tap, 48_000, 16_000).len() < MIN_TRANSCRIBABLE_SAMPLES);

        // Half a second of speech is transcribed.
        let utterance = vec![0.1_f32; 48_000 / 2];
        assert!(resample_linear(&utterance, 48_000, 16_000).len() >= MIN_TRANSCRIBABLE_SAMPLES);

        // So is a short utterance captured over a narrowband hands-free link.
        let narrowband = vec![0.1_f32; 8_000 / 2];
        assert!(resample_linear(&narrowband, 8_000, 16_000).len() >= MIN_TRANSCRIBABLE_SAMPLES);
    }

    #[test]
    fn truncated_capture_reports_audio_duration_not_hold_time() {
        // The headset died two seconds into a thirty-second hold: WPM must
        // divide by the audio we kept, not by how long the key was down.
        assert_eq!(
            effective_duration_seconds(Some(30.0), 96_000, 48_000),
            Some(2.0)
        );
        // A healthy capture still reports the shorter of the two, discarding
        // the device-open latency that precedes the first frame.
        assert_eq!(
            effective_duration_seconds(Some(2.05), 96_000, 48_000),
            Some(2.0)
        );
        assert_eq!(effective_duration_seconds(None, 96_000, 48_000), None);
        assert_eq!(effective_duration_seconds(Some(3.0), 0, 48_000), Some(0.0));
        // A missing sample rate must not divide by zero.
        assert_eq!(effective_duration_seconds(Some(3.0), 10, 0), Some(3.0));
    }

    #[test]
    fn stall_watch_reports_a_device_that_never_delivers_a_frame() {
        // OS microphone privacy block, or a Bluetooth handshake that opened the
        // stream but never produced audio: the counter sits at zero.
        let mut watch = StallWatch::new();
        for _ in 0..(STALL_TICKS - 1) {
            assert!(!watch.observe(0));
        }
        assert!(watch.observe(0), "stall must be reported at the threshold");
    }

    #[test]
    fn stall_watch_reports_only_once_per_capture() {
        let mut watch = StallWatch::new();
        assert!(!watch.observe(7), "the first tick only seeds the counter");
        for _ in 0..(STALL_TICKS - 1) {
            assert!(!watch.observe(7));
        }
        assert!(watch.observe(7));
        // The stall persists, but the user must not get a notice every 33 ms.
        for _ in 0..(STALL_TICKS * 3) {
            assert!(!watch.observe(7));
        }
    }

    #[test]
    fn stall_watch_ignores_a_healthy_capture() {
        let mut watch = StallWatch::new();
        for frames in 1..(STALL_TICKS as u64 * 4) {
            assert!(!watch.observe(frames));
        }
    }

    #[test]
    fn stall_watch_forgives_jitter_below_the_threshold() {
        // Bluetooth links stutter. A gap that recovers is not a disconnect.
        let mut watch = StallWatch::new();
        assert!(!watch.observe(12), "the first tick only seeds the counter");
        for _ in 0..(STALL_TICKS - 1) {
            assert!(!watch.observe(12));
        }
        assert!(!watch.observe(13), "a resumed frame must reset the count");
        for _ in 0..(STALL_TICKS - 1) {
            assert!(!watch.observe(13));
        }
        assert!(watch.observe(13));
    }

    #[test]
    fn uncommitted_start_guard_releases_the_recording_flag() {
        let flag = Arc::new(AtomicBool::new(true));
        drop(StartGuard {
            is_recording: Arc::clone(&flag),
            committed: false,
        });
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn committed_start_guard_leaves_a_newer_capture_alone() {
        // The superseded-start abort path commits on purpose: the stop or
        // cancel that overtook it already cleared the flag, and a fresh
        // capture may already own it again.
        let flag = Arc::new(AtomicBool::new(true));
        let mut guard = StartGuard {
            is_recording: Arc::clone(&flag),
            committed: false,
        };
        guard.commit();
        drop(guard);
        assert!(flag.load(Ordering::SeqCst));
    }
}
