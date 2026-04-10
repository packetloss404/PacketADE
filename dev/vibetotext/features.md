# VibeToText Integration — Feature Spec

Last updated: 2026-04-09

## 1. Native Dictation Engine (Rust Backend)

### 1.1 New Rust Dependencies

```toml
# src-tauri/Cargo.toml
cpal = "0.17"                                           # Audio capture (WASAPI on Windows)
whisper-rs = "0.16"                                     # Whisper.cpp bindings for transcription
rustfft = "6"                                           # FFT for waveform visualization
rusqlite = { version = "0.33", features = ["bundled"] } # Local dictation history
clipboard-win = "5.0"                                   # Clipboard operations (Windows)
enigo = "0.2"                                           # Keyboard simulation for auto-paste
```

### 1.2 Command Module Structure

New module at `src-tauri/src/commands/dictation/`:

```
dictation/
  mod.rs          # Tauri command exports
  audio.rs        # cpal recording + FFT waveform event emission
  whisper.rs      # WhisperContext lifecycle, inference, vocab biasing
  history.rs      # rusqlite CRUD for ~/.packetcode/dictation.db
  analytics.rs    # Aggregate stats from history
  config.rs       # Settings read/write (~/.packetcode/dictation.json)
  models.rs       # Whisper model download and management
```

### 1.3 Tauri Commands

| Command | Args | Returns | Description |
|---------|------|---------|-------------|
| `list_audio_devices` | — | `Vec<AudioDevice>` | Enumerate mics via cpal |
| `start_recording` | `device_index: Option<u32>` | `()` | Begin capture, emit `dictation:waveform` events |
| `stop_recording` | — | `TranscriptionResult` | Stop capture, run Whisper, return text |
| `get_dictation_history` | `limit: u32, offset: u32` | `Vec<DictationEntry>` | Paginated history from SQLite |
| `get_dictation_analytics` | — | `DictationAnalytics` | Computed stats (WPM, word freq, etc.) |
| `search_dictation_history` | `query: String` | `Vec<DictationEntry>` | Full-text search |
| `get_dictation_settings` | — | `DictationSettings` | Read config |
| `set_dictation_settings` | `settings: DictationSettings` | `()` | Save config |
| `download_whisper_model` | `size: String` | `()` | Download model, emit progress events |
| `list_whisper_models` | — | `Vec<WhisperModel>` | Available/downloaded models |

### 1.4 Audio Capture (`audio.rs`)

- **Sample rate:** 16,000 Hz mono (Whisper's native rate)
- **Format:** f32 PCM normalized to [-1, 1]
- **Buffer:** Thread-safe `Arc<Mutex<Vec<f32>>>`, cpal callback appends chunks
- **FFT waveform:** 512-point FFT with Hanning window, mapped to 25 exponential frequency bars
- **Event emission:** `dictation:waveform` Tauri event at ~30fps with `[f32; 25]` payload
- **Silence gating:** RMS threshold at 0.08, mute bars when below
- **Bass reduction:** First 4 bars attenuated to reduce microphone rumble

### 1.5 Whisper Transcription (`whisper.rs`)

- **Model storage:** `~/.packetcode/models/ggml-{size}.bin`
- **Lazy loading:** WhisperContext created on first use, kept in `Mutex<Option<WhisperContext>>`
- **Inference:** `tokio::task::spawn_blocking` to avoid blocking the async runtime
- **Vocabulary biasing:** Initial prompt with 200+ programming terms ported from vibetotext:
  - Cloud: AWS, S3, EC2, Lambda, DynamoDB, GCP, Azure, Vercel, Railway
  - Languages: JavaScript, TypeScript, Python, Rust, Go, Java, Swift, Kotlin
  - Frameworks: React, Vue, Angular, Next.js, Django, FastAPI
  - Databases: MongoDB, PostgreSQL, MySQL, SQLite, Redis
  - DevOps: Docker, Kubernetes, Terraform, CI/CD, GitHub Actions
  - APIs: REST, GraphQL, gRPC, WebSocket, OAuth, JWT
  - AI/ML: Claude, GPT, Gemini, LLM, embedding, RAG
- **Custom dictionary:** User words loaded from config and appended to prompt
- **Artifact filtering:** Remove `[BLANK_AUDIO]`, `[silence]`, `[inaudible]`, `[no speech]` markers
- **Model sizes available:** tiny (~75MB), base (~142MB), small (~466MB), medium (~1.5GB), large-v3 (~3GB)
- **Default model:** small (good balance of speed and accuracy)

### 1.6 History Database (`history.rs`)

Location: `~/.packetcode/dictation.db`

```sql
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'transcribe',
    timestamp TEXT NOT NULL,
    word_count INTEGER,
    duration_seconds REAL,
    wpm INTEGER,
    sentiment REAL
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_mode ON entries(mode);
```

Schema matches vibetotext's format for potential future import/export compatibility.

### 1.7 Analytics Computation (`analytics.rs`)

Computed from the history database on demand:

- **Total entries, total words, average WPM**
- **Hourly activity:** 24-slot array counting transcriptions per hour
- **Top words:** Top 20 most frequent words (filtered by stopword list, length > 2)
- **Mode breakdown:** Count by mode (transcribe, cleanup, plan)
- **Vocabulary diversity:** unique words / total words ratio
- **Daily streak:** Consecutive days with at least one transcription
- **Time saved estimate:** `(total_words / 40) - (total_duration / 60)` minutes (40 WPM = average typing speed)

### 1.8 Auto-Paste Flow

After transcription completes:
1. Copy text to clipboard via `clipboard-win`
2. Small delay (50ms) for clipboard sync
3. Simulate `Ctrl+V` via `enigo`
4. Return result to frontend for display

Auto-paste is configurable (on/off in settings). When off, text is only copied to clipboard.

---

## 2. Frontend — Dictation Module

### 2.1 Types (`src/types/dictation.ts`)

```typescript
export interface DictationEntry {
  id: number;
  text: string;
  mode: string;           // "transcribe" | "cleanup" | "plan"
  timestamp: string;
  wordCount: number;
  durationSeconds: number;
  wpm: number;
  sentiment: number;       // -1 to 1
}

export interface DictationAnalytics {
  totalEntries: number;
  totalWords: number;
  averageWpm: number;
  hourlyActivity: number[];      // 24 slots
  topWords: [string, number][];  // [word, count]
  modeBreakdown: Record<string, number>;
  vocabularyDiversity: number;
  dailyStreak: number;
  timeSavedMinutes: number;
}

export interface DictationSettings {
  modelSize: string;
  deviceIndex: number | null;
  customDictionary: string[];
  autoPaste: boolean;
}

export interface WhisperModel {
  size: string;
  downloaded: boolean;
  fileSizeMb: number;
  path: string | null;
}

export interface AudioDevice {
  index: number;
  name: string;
  isDefault: boolean;
}
```

### 2.2 Store (`src/stores/dictationStore.ts`)

Zustand store following existing patterns:

```typescript
interface DictationStore {
  // Recording state
  isRecording: boolean;
  waveform: number[];         // 25 bars, 0-1 range
  lastResult: string | null;

  // Data
  history: DictationEntry[];
  analytics: DictationAnalytics | null;
  settings: DictationSettings | null;
  models: WhisperModel[];

  // Actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string>;
  loadHistory: (limit?: number, offset?: number) => Promise<void>;
  loadAnalytics: () => Promise<void>;
  loadSettings: () => Promise<void>;
  updateSettings: (settings: DictationSettings) => Promise<void>;
  loadModels: () => Promise<void>;
  downloadModel: (size: string) => Promise<void>;
  searchHistory: (query: string) => Promise<void>;
}
```

Event listener setup: on store creation, listen for `dictation:waveform` Tauri events and update `waveform` state.

### 2.3 Module Registration

**New file: `src/modules/dictation.ts`**
```typescript
export const dictationModule: ModuleManifest = {
  id: "dictation",
  name: "Dictation",
  description: "Voice-to-text with local Whisper transcription",
  icon: Mic,
  iconColor: "text-accent-purple",
  component: DictationView,
  category: "integration",
  enabledByDefault: true,
};
```

**Modified: `src/modules/registry.ts`** — add to `ALL_MODULES` array

### 2.4 Dictation Module View (`src/components/views/DictationView.tsx`)

Three-tab layout:

**Tab 1: Record**
- Large circular mic button (toggle recording on/off)
- 25-bar waveform visualizer (horizontal bars, animated from `dictationStore.waveform`)
- Status text: "Ready" / "Recording..." / "Transcribing..." / "Done"
- Transcription result display area (appears after stop)
- Copy button, paste button
- Duration and word count badges

**Tab 2: History**
- Search bar at top
- Scrollable list of transcription entries
- Each entry shows: text preview, mode badge, timestamp, word count, WPM, sentiment dot
- Mode filter buttons: All | Transcribe | Cleanup | Plan
- Pagination (load more on scroll)

**Tab 3: Analytics**
- Summary cards: Total Transcriptions, Total Words, Avg WPM, Time Saved, Streak
- Hourly activity heatmap (24 columns, colored by count)
- Top words list (bar chart or tag cloud)
- Mode breakdown (small bar chart)
- Vocabulary diversity score

### 2.5 Updated Voice Input Hook (`src/hooks/useVoiceInput.ts`)

Extend with a `mode` parameter:

```typescript
export function useVoiceInput(mode: "web" | "native" = "native") {
  // "web" — existing Web Speech API path (unchanged)
  // "native" — calls dictation Tauri commands
}
```

When `mode === "native"`:
- `startListening()` calls `invoke("start_recording")`
- `stopListening()` calls `invoke("stop_recording")`, sets transcript
- `isSupported` checks if a Whisper model is downloaded

Auto-detection: default to `"native"` if a model exists, fall back to `"web"`.

### 2.6 Mic Button in Chat Inputs

Add mic button to existing chat inputs using the same pattern already in InsightsView:

- **`src/components/views/InsightsView.tsx`** — update to use native mode
- **`src/components/flights/FlightChatPanel.tsx`** — add mic button

Pattern: small mic icon button next to the send button, toggles recording state.

---

## 3. Analytics Migration to Tools Page

### 3.1 Extract Analytics Card

**New file: `src/components/views/tools/AnalyticsCard.tsx`**

Extract from `AnalyticsView.tsx`:
- Summary cards row: Total Cost, Sessions, Input Tokens, Output Tokens
- Daily cost chart (last 30 days) with hover tooltips
- Model breakdown table
- Session history tab (7-day chart, cost by model, session summaries)
- Tab switcher: Overview | Session History
- Refresh button

Wrapped in Tools-page card styling: `bg-bg-secondary border border-bg-border rounded-lg p-4`

### 3.2 Dictation Settings Card

**New file: `src/components/views/tools/DictationCard.tsx`**

Settings and management for the dictation engine:
- **Model Manager:** List available models with download/delete buttons, show file size and download status
- **Microphone:** Dropdown of audio devices from `list_audio_devices`, with test button
- **Custom Dictionary:** Editable word list (add/remove terms), hot-reloaded before each transcription
- **Auto-Paste:** Toggle on/off
- **Stats Summary:** Total transcriptions, total words, avg WPM (quick view, links to full module)
- **Open Dictation** button to navigate to the full module view

### 3.3 Tools Page Changes

**Modified: `src/components/views/ToolsView.tsx`**

```typescript
type SettingsSection = "project" | "issues" | "profiles" | "routing"
                     | "modules" | "templates" | "analytics" | "dictation";

const SECTIONS = [
  // ... existing 6 sections ...
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "dictation", label: "Dictation", icon: Mic },
];
```

### 3.4 Navigation Updates

**Modified: `src/stores/appStore.ts`**
- Remove `"analytics"` from `CoreView` union type
- Add `toolsSection: string | null` and `setToolsSection: (s: string | null) => void`
- Migration: if persisted `activeView` is `"analytics"`, redirect to `"tools"`

**Modified: `src/components/layout/Toolbar.tsx`**
- Dollar sign button: `setActiveView("tools"); setToolsSection("analytics")`
- "Cost & Usage" dropdown item: same
- Remove any standalone analytics view references

**Modified: `src/components/views/ToolsView.tsx`**
- On mount: read `appStore.toolsSection`, set as active section, clear it

**Modified: `src/App.tsx`**
- Remove `AnalyticsView` lazy import and render case
- Delete `src/components/views/AnalyticsView.tsx` after migration

---

## 4. Data Storage Locations

| Data | Location | Format |
|------|----------|--------|
| Dictation history | `~/.packetcode/dictation.db` | SQLite |
| Dictation config | `~/.packetcode/dictation.json` | JSON |
| Whisper models | `~/.packetcode/models/` | GGML binary |
| Cost analytics | `~/.claude/cost-tally.json` | JSON (read-only) |
| Cost entries | `localStorage:packetcode:cost-entries` | JSON |

## 5. Tauri Event Names

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `dictation:waveform` | Backend → Frontend | `[f32; 25]` | Real-time FFT bars |
| `dictation:status` | Backend → Frontend | `string` | "recording" / "transcribing" / "done" / "error" |
| `dictation:model-progress` | Backend → Frontend | `{ size, percent }` | Model download progress |

Uses scoped event names per the project's AI streaming pattern convention (like `insights:chunk`, `flight-chat:chunk`).
