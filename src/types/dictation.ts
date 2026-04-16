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
