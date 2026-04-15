# VibeToText Integration — Sprint Plan

## Implementation Status — 2026-04-15

| Sprint | Status | Notes |
|--------|--------|-------|
| Sprint 1: Analytics migration | ✅ Done | AnalyticsCard in Tools page |
| Sprint 2: Rust dictation backend | ✅ Done | commands/dictation/ module with whisper-rs |
| Sprint 3: History + Settings backend | ✅ Done | SQLite history + config persistence |
| Sprint 4: Frontend store/types/hooks | ✅ Done | dictationStore + native mode in useVoiceInput |
| Sprint 5: DictationView + Tools card | ✅ Done | Full module view + Tools card |
| Sprint 6: Chat integration + polish | ✅ Done | Native voice in Insights + Flight chat |

Note: useVoiceInput hook is actively used in the new Agents tab with browser Web Speech API.

Last updated: 2026-04-09

## Sprint 1: Analytics Migration to Tools Page

**Goal:** Move cost/usage analytics from standalone CoreView into the Tools page.

### Tasks

1. **Create `src/components/views/tools/AnalyticsCard.tsx`**
   - Extract content from `AnalyticsView.tsx` into a card component
   - Wrap in Tools-page card styling
   - Keep tab switcher (Overview / Session History)
   - Import and use `analyticsStore` as-is

2. **Update `src/components/views/ToolsView.tsx`**
   - Add `"analytics"` to `SettingsSection` type
   - Add Analytics entry to `SECTIONS` array with `BarChart3` icon
   - Render `AnalyticsCard` when section is `"analytics"`

3. **Update `src/stores/appStore.ts`**
   - Remove `"analytics"` from `CoreView` type
   - Add `toolsSection: string | null` + `setToolsSection()` action
   - Add migration guard: if persisted activeView is `"analytics"`, redirect to `"tools"`

4. **Update `src/components/layout/Toolbar.tsx`**
   - Dollar sign button navigates to `tools` with `setToolsSection("analytics")`
   - "Cost & Usage" dropdown item does the same
   - Remove standalone analytics view references

5. **Update `src/App.tsx`**
   - Remove `AnalyticsView` lazy import and switch case

6. **Update `src/components/views/ToolsView.tsx`**
   - On mount, read `appStore.toolsSection`, apply as active section, clear it

7. **Delete `src/components/views/AnalyticsView.tsx`**

### Acceptance Criteria

- [ ] Tools > Analytics shows the same cost/usage data as the old standalone view
- [ ] Toolbar dollar sign button lands on Tools > Analytics section
- [ ] No references to `"analytics"` as a CoreView remain
- [ ] `pnpm build` and `pnpm lint` pass
- [ ] Existing localStorage data survives the migration

---

## Sprint 2: Rust Dictation Backend — Audio + Whisper

**Goal:** Build the core audio capture and Whisper transcription pipeline in Rust.

### Tasks

1. **Add dependencies to `src-tauri/Cargo.toml`**
   ```toml
   cpal = "0.17"
   whisper-rs = "0.16"
   rustfft = "6"
   rusqlite = { version = "0.33", features = ["bundled"] }
   ```

2. **Create `src-tauri/src/commands/dictation/` module**
   - `mod.rs` — export all submodules and Tauri command functions
   - `audio.rs` — cpal device enumeration, recording start/stop, FFT waveform computation and event emission
   - `whisper.rs` — model loading, inference with initial prompt, artifact filtering

3. **Register in `src-tauri/src/commands/mod.rs`** — `pub mod dictation;`

4. **Register commands in `src-tauri/src/lib.rs`** — add to `generate_handler![]`:
   - `list_audio_devices`, `start_recording`, `stop_recording`
   - `list_whisper_models`, `download_whisper_model`

5. **Implement audio capture**
   - cpal stream with 16kHz mono f32
   - Thread-safe buffer (`Arc<Mutex<Vec<f32>>>`)
   - FFT: 512-point with Hanning window → 25 exponential frequency bars
   - Emit `dictation:waveform` events at ~30fps
   - Silence gating (RMS < 0.08)

6. **Implement Whisper inference**
   - Model download to `~/.packetcode/models/`
   - `WhisperContext` lazy-loaded in `Mutex<Option<>>`
   - Inference via `spawn_blocking`
   - Initial prompt with 200+ programming terms
   - Artifact removal regex

### Acceptance Criteria

- [ ] `list_audio_devices` returns available microphones
- [ ] `start_recording` captures audio and emits waveform events
- [ ] `stop_recording` returns transcribed text from a short speech sample
- [ ] Model download works for at least "tiny" model
- [ ] `cargo check` passes
- [ ] No panics on missing microphone

---

## Sprint 3: Dictation History + Settings Backend

**Goal:** Persist transcription history and user settings.

### Tasks

1. **Create `src-tauri/src/commands/dictation/history.rs`**
   - SQLite database at `~/.packetcode/dictation.db`
   - Create table on first access
   - CRUD: insert entry, get paginated, search, count
   - WPM calculation: `word_count / (duration_seconds / 60)`

2. **Create `src-tauri/src/commands/dictation/analytics.rs`**
   - Query history for aggregated stats
   - Compute: total entries, total words, avg WPM, hourly activity, top words, mode breakdown, vocabulary diversity, streak, time saved

3. **Create `src-tauri/src/commands/dictation/config.rs`**
   - Read/write `~/.packetcode/dictation.json`
   - Fields: modelSize, deviceIndex, customDictionary, autoPaste

4. **Register remaining commands in `lib.rs`**
   - `get_dictation_history`, `get_dictation_analytics`, `search_dictation_history`
   - `get_dictation_settings`, `set_dictation_settings`

5. **Wire stop_recording to save history**
   - After transcription, insert entry into SQLite with word count, duration, WPM

### Acceptance Criteria

- [ ] Transcriptions persist across app restarts
- [ ] History query returns paginated results
- [ ] Search finds entries by text content
- [ ] Analytics returns computed stats
- [ ] Settings save and load correctly
- [ ] Database created automatically on first use

---

## Sprint 4: Frontend — Dictation Store, Types, Tauri Bindings

**Goal:** Build the frontend data layer for dictation.

### Tasks

1. **Create `src/types/dictation.ts`**
   - DictationEntry, DictationAnalytics, DictationSettings, WhisperModel, AudioDevice interfaces

2. **Create `src/stores/dictationStore.ts`**
   - Zustand store with recording state, waveform, history, analytics, settings, models
   - Actions wrapping all Tauri invoke calls
   - Tauri event listener for `dictation:waveform` and `dictation:status`

3. **Add Tauri invoke wrappers to `src/lib/tauri.ts`**
   - All dictation commands with typed args and return values

4. **Update `src/hooks/useVoiceInput.ts`**
   - Add `mode: "web" | "native"` parameter
   - Native mode: invoke `start_recording` / `stop_recording`
   - Auto-detect: native if model downloaded, else web
   - Keep existing Web Speech API path unchanged

### Acceptance Criteria

- [ ] `dictationStore.startRecording()` triggers audio capture
- [ ] Waveform state updates at ~30fps during recording
- [ ] `dictationStore.stopRecording()` returns transcribed text
- [ ] History and analytics load from backend
- [ ] `useVoiceInput("native")` works as drop-in replacement

---

## Sprint 5: Frontend — Dictation Module View + Tools Card

**Goal:** Build the full dictation UI.

### Tasks

1. **Create `src/components/views/DictationView.tsx`**
   - Three tabs: Record, History, Analytics
   - Record tab: mic button, waveform visualizer, result display, copy button
   - History tab: search, mode filters, paginated entry list, sentiment dots
   - Analytics tab: summary cards, hourly heatmap, top words, mode breakdown

2. **Create `src/modules/dictation.ts`**
   - Module manifest: id "dictation", icon Mic, category "integration"

3. **Update `src/modules/registry.ts`**
   - Import and add dictationModule to `ALL_MODULES`

4. **Create `src/components/views/tools/DictationCard.tsx`**
   - Model manager: list models, download/delete buttons, size + status
   - Microphone selector: dropdown from `list_audio_devices`
   - Custom dictionary: editable word list
   - Auto-paste toggle
   - Quick stats summary
   - "Open Dictation" button → navigates to module view

5. **Update `src/components/views/ToolsView.tsx`**
   - Add `"dictation"` to `SettingsSection`
   - Add Dictation entry to SECTIONS with `Mic` icon
   - Render `DictationCard` when section is `"dictation"`

### Acceptance Criteria

- [ ] Dictation module appears in Tools dropdown when enabled
- [ ] Record tab: click mic, waveform animates, transcription appears on stop
- [ ] History tab: shows past transcriptions with search and filters
- [ ] Analytics tab: renders computed stats
- [ ] Tools > Dictation: model download works, settings save
- [ ] Microphone selection persists

---

## Sprint 6: Chat Input Integration + Polish

**Goal:** Add mic buttons to all chat inputs, polish the experience.

### Tasks

1. **Update `src/components/views/InsightsView.tsx`**
   - Change `useVoiceInput()` to `useVoiceInput("native")`
   - Existing mic button UI works as-is

2. **Update `src/components/flights/FlightChatPanel.tsx`**
   - Add mic button next to send button (same pattern as InsightsView)
   - Import `useVoiceInput`, wire up toggle

3. **Add auto-paste support**
   - Add `clipboard-win` and `enigo` to Cargo.toml
   - Implement paste flow in `stop_recording`: copy to clipboard → Ctrl+V
   - Respect `autoPaste` setting

4. **Polish**
   - Loading states during model download (progress bar)
   - Error handling: no mic available, model not downloaded, transcription failed
   - First-run experience: prompt to download a model on first visit to Dictation

### Acceptance Criteria

- [ ] Insights mic button uses native Whisper transcription
- [ ] Flight chat has a working mic button
- [ ] Auto-paste works when enabled (text appears at cursor in external apps)
- [ ] Graceful errors for missing mic or model
- [ ] `pnpm build` and `pnpm lint` pass
- [ ] Full round-trip: click mic → speak → text appears in input field

---

## File Change Summary

### New Files

| File | Sprint | Purpose |
|------|--------|---------|
| `src-tauri/src/commands/dictation/mod.rs` | 2 | Module exports |
| `src-tauri/src/commands/dictation/audio.rs` | 2 | Audio capture + FFT |
| `src-tauri/src/commands/dictation/whisper.rs` | 2 | Whisper inference |
| `src-tauri/src/commands/dictation/history.rs` | 3 | SQLite history CRUD |
| `src-tauri/src/commands/dictation/analytics.rs` | 3 | History stats computation |
| `src-tauri/src/commands/dictation/config.rs` | 3 | Settings read/write |
| `src-tauri/src/commands/dictation/models.rs` | 2 | Model download/management |
| `src/types/dictation.ts` | 4 | TypeScript interfaces |
| `src/stores/dictationStore.ts` | 4 | Zustand store |
| `src/components/views/DictationView.tsx` | 5 | Full module view |
| `src/components/views/tools/AnalyticsCard.tsx` | 1 | Analytics in Tools page |
| `src/components/views/tools/DictationCard.tsx` | 5 | Dictation settings in Tools |
| `src/modules/dictation.ts` | 5 | Module manifest |

### Modified Files

| File | Sprint | Change |
|------|--------|--------|
| `src-tauri/Cargo.toml` | 2 | Add cpal, whisper-rs, rustfft, rusqlite |
| `src-tauri/src/commands/mod.rs` | 2 | Add `pub mod dictation` |
| `src-tauri/src/lib.rs` | 2, 3 | Register dictation commands |
| `src/lib/tauri.ts` | 4 | Add dictation invoke wrappers |
| `src/hooks/useVoiceInput.ts` | 4 | Add native mode |
| `src/stores/appStore.ts` | 1 | Remove analytics CoreView, add toolsSection |
| `src/components/views/ToolsView.tsx` | 1, 5 | Add analytics + dictation sections |
| `src/components/layout/Toolbar.tsx` | 1 | Update analytics navigation |
| `src/App.tsx` | 1 | Remove AnalyticsView |
| `src/modules/registry.ts` | 5 | Add dictationModule |
| `src/components/views/InsightsView.tsx` | 6 | Switch to native voice mode |
| `src/components/flights/FlightChatPanel.tsx` | 6 | Add mic button |

### Deleted Files

| File | Sprint | Reason |
|------|--------|--------|
| `src/components/views/AnalyticsView.tsx` | 1 | Content moved to AnalyticsCard |
