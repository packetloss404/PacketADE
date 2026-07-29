export interface DictationEntry {
  id: number;
  text: string;
  mode: string;
  timestamp: string;
  wordCount: number | null;
  durationSeconds: number | null;
  wpm: number | null;
  sentiment: number | null;
}

export interface DictationAnalytics {
  totalEntries: number;
  totalWords: number;
  averageWpm: number;
  fastestWpm: number;
  averageSentiment: number;
  totalDurationMinutes: number;
  longestEntryWords: number;
  hourlyActivity: number[];
  topWords: [string, number][];
  modeBreakdown: Record<string, number>;
  vocabularyDiversity: number;
  dailyStreak: number;
  timeSavedMinutes: number;
}

export interface DictationSettings {
  modelSize: string;
  /** Stable host-qualified CPAL identity. Preferred over deviceIndex. */
  deviceId: string | null;
  /** Legacy migration fallback for settings created before v0.10.3. */
  deviceIndex: number | null;
  customDictionary: string[];
  autoPaste: boolean;
  /** Whisper language code, or "auto" for language detection. */
  language: string;
  /** Paste into the foreground OS application when no PacketADE field is active. */
  systemWidePaste: boolean;
  /** OS-global accelerator for push-to-talk (hold). Optional — falls back to
   *  the hardcoded default in `useDictationGlobalShortcuts` when omitted. */
  pushToTalkShortcut?: string;
  /** OS-global accelerator for toggle recording. */
  toggleShortcut?: string;
  /** Explicit opt-in for OS-global shortcut registration. */
  globalShortcutsEnabled: boolean;
  /** Hard upper bound for retained PCM, clamped by the backend to 10–1800s. */
  maxDurationSeconds: number;
}

/** Default accelerator strings — kept in one place so the store, the
 *  capture UI, and the global-shortcut hook agree. Format follows
 *  `@tauri-apps/plugin-global-shortcut` accelerator syntax. */
export const DEFAULT_PUSH_TO_TALK_SHORTCUT = "CommandOrControl+Alt+Space";
export const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Alt+R";
export const DICTATION_OPEN_SHORTCUT = "CommandOrControl+Shift+D";

export interface WhisperModel {
  size: string;
  downloaded: boolean;
  installed: boolean;
  fileSizeMb: number;
  path: string | null;
}

export interface AudioDevice {
  index: number;
  id: string | null;
  name: string;
  isDefault: boolean;
  sampleRate: number | null;
  channels: number | null;
  sampleFormat: string | null;
}

export interface AudioDeviceTestResult {
  deviceId: string | null;
  name: string;
  sampleRate: number;
  channels: number;
  sampleFormat: string;
  capturedFrames: number;
  durationMs: number;
  peakLevel: number;
  rmsLevel: number;
  warning: string | null;
}

export interface DictationResult {
  text: string;
  durationSeconds: number | null;
  inputSampleRate: number;
  channels: number;
  sampleFormat: string;
  deviceName: string;
  deviceId: string | null;
  modelSize: string;
  detectedLanguage: string | null;
  modelLoadMs: number;
  inferenceMs: number;
  warnings: string[];
}

export type DictationShortcutStatus =
  | { state: "disabled"; message: string }
  | { state: "registering"; message: string }
  | { state: "ready"; message: string }
  | { state: "error"; message: string };

export function validateDictationShortcuts(
  pushToTalk: string,
  toggle: string,
  open = DICTATION_OPEN_SHORTCUT,
): string | null {
  const values = [pushToTalk.trim(), toggle.trim(), open.trim()];
  if (values.some((value) => value.length === 0)) {
    return "Shortcut values cannot be empty.";
  }
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    return "Push-to-talk, toggle, and open shortcuts must be different.";
  }
  return null;
}
