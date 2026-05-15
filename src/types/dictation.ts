export interface DictationEntry {
  id: number;
  text: string;
  mode: string;
  timestamp: string;
  wordCount: number;
  durationSeconds: number;
  wpm: number;
  sentiment: number;
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
  deviceIndex: number | null;
  customDictionary: string[];
  autoPaste: boolean;
  /** OS-global accelerator for push-to-talk (hold). Optional — falls back to
   *  the hardcoded default in `useDictationGlobalShortcuts` when omitted. */
  pushToTalkShortcut?: string;
  /** OS-global accelerator for toggle recording. */
  toggleShortcut?: string;
}

/** Default accelerator strings — kept in one place so the store, the
 *  capture UI, and the global-shortcut hook agree. Format follows
 *  `@tauri-apps/plugin-global-shortcut` accelerator syntax. */
export const DEFAULT_PUSH_TO_TALK_SHORTCUT = "CommandOrControl+Shift+V";
export const DEFAULT_TOGGLE_SHORTCUT = "CommandOrControl+Shift+R";

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
