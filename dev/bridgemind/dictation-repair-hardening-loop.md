# PacketADE Dictation Repair and Hardening Loop

Status: **Option B approved; repair implementation complete; physical microphone
smoke environment-gated**

Last updated: 2026-07-28

## Decision

Keep Dictation inside PacketADE and make the existing local-first package
reliable. Do not create a standalone PacketVoice product, add a cloud
dependency, or chase every BridgeVoice model before the basic path is proven.

The required product loop is:

```text
ready model + active microphone
  → native capture
  → mono 16 kHz audio
  → local Whisper
  → PacketADE field / clipboard / opt-in Windows paste
  → history + analytics
```

## Reproduced failure

The failure was a chain, not one missing command:

1. Local settings selected `small`, whose valid legacy model file lacked the
   new checksum marker. A verified `medium` model existed but the UI could not
   select it.
2. Capture fabricated an exact 16 kHz/mono/f32 stream instead of using the
   microphone's supported format. Common Windows microphones expose 44.1/48
   kHz, multiple channels, or integer PCM.
3. The saved microphone index was never used by normal recording callers.
4. Rust emitted `{ bars }` while the frontend treated the waveform as
   `number[]`.
5. Window and global shortcut starts could race; a quick push-to-talk release
   during startup was lost.
6. Dictionary and history features were presented but disconnected.
7. The Composer hook bypassed the shared lifecycle and hid native errors.

This Windows host currently exposes **zero active capture endpoints**. Privacy
is allowed and audio services run, but the recorded MMDevice endpoints are
`NotPresent`. That blocks a physical end-to-end smoke until a microphone is
connected or enabled; the repaired UI now reports the condition.

## Completed loop

- [x] **DV1 — Truth and reproduction.** Inspect local config/models/database,
  trace every frontend caller, verify command registration, and inspect the
  Windows capture state.
- [x] **DV2 — Model readiness.** Add an active-model selector, distinguish an
  installed legacy file from a verified model, offer one-click verification,
  and fall back to a verified local model before recording.
- [x] **DV3 — Native audio repair.** Open CPAL's supported default input
  configuration, handle PCM sample formats, downmix interleaved channels, and
  resample to Whisper's 16 kHz mono contract.
- [x] **DV4 — Lifecycle repair.** Atomically guard backend start, add frontend
  `starting`, queue a quick PTT release, add real cancel/discard, and invalidate
  old waveform workers by recording generation.
- [x] **DV5 — Event and error contracts.** Emit the canonical waveform array,
  accept the legacy payload during hot reload, surface capture failures, and
  show a no-device message.
- [x] **DV6 — Transcription truth.** Add auto/fixed language, sanitize and
  bound custom dictionary hints, place user terms before curated vocabulary,
  and keep local Whisper as the only engine.
- [x] **DV7 — Delivery.** Preserve React-aware in-app insertion; clear stale
  targets when PacketADE loses focus; copy natively on Windows; add opt-in
  foreground Ctrl+V without restoring an older, potentially sensitive
  clipboard value; report delivery outcome.
- [x] **DV8 — History and analytics.** Persist successful transcriptions with
  duration, word count, and WPM; fix the Rust/TypeScript camel-case contract;
  refresh history/analytics after completion.
- [x] **DV9 — One frontend controller.** Route Composer native dictation,
  global shortcuts, and the Dictation view through `dictationStore`; remove the
  process-lifetime readiness cache and silent command failures.
- [x] **DV10 — Automated gates.** Add store regression coverage for settings
  migration/device use, release-during-start, and cancel. Add Rust tests for
  stereo downmix, 48→16 kHz resampling, and dictionary sanitization/bounds.

## Verification record

- `pnpm exec vitest run src/stores/__tests__/dictationStore.test.ts`
- `pnpm build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml commands::dictation --no-run`

Rust test binaries compile, but executing native Rust tests on this Windows
runtime remains blocked by the repository-wide `0xc0000139` entrypoint defect.

## Remaining hardening backlog

These are useful reliability improvements, but they do not reopen the repaired
record/transcribe/deliver path:

The executable DV11–DV17 acceptance ledger and run order live in
[`pre-remote-agents-loop-queue.md`](./pre-remote-agents-loop-queue.md). The
remaining work covers microphone doctor/stable identity, bounded recovery,
shortcut trust, native insertion, packaged platform prerequisites, structured
private telemetry, and an evidence-gated engine/acceleration benchmark.

## Research basis

- [CPAL device/config and stream contract](https://docs.rs/cpal/latest/cpal/)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [whisper-rs transcription parameters](https://docs.rs/whisper-rs/latest/whisper_rs/struct.FullParams.html)
- [Tauri global shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/)
- [Windows `SendInput` limitations](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- [BridgeVoice product benchmark](https://www.bridgemind.ai/products/bridgevoice)
