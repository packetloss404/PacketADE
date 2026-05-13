import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DictationEntry,
  DictationAnalytics,
  DictationSettings,
  WhisperModel,
} from "@/types/dictation";
import {
  startRecordingCmd,
  stopRecordingCmd,
  getDictationHistory,
  getDictationAnalytics,
  searchDictationHistory,
  getDictationSettings,
  setDictationSettings,
  downloadWhisperModel as downloadWhisperModelCmd,
  listWhisperModels,
} from "@/lib/tauri";

interface DictationStore {
  isRecording: boolean;
  isTranscribing: boolean;
  waveform: number[];
  lastResult: string | null;
  status: "idle" | "recording" | "transcribing" | "done" | "error";
  error: string | null;

  history: DictationEntry[];
  analytics: DictationAnalytics | null;
  settings: DictationSettings | null;
  models: WhisperModel[];

  startRecording: (deviceIndex?: number) => Promise<void>;
  stopRecording: () => Promise<string>;
  loadHistory: (limit?: number, offset?: number) => Promise<void>;
  searchHistory: (query: string) => Promise<void>;
  loadAnalytics: () => Promise<void>;
  loadSettings: () => Promise<void>;
  updateSettings: (settings: DictationSettings) => Promise<void>;
  loadModels: () => Promise<void>;
  downloadModel: (size: string) => Promise<void>;
  clearResult: () => void;
}

// Set up global event listeners once
const eventListeners: UnlistenFn[] = [];
let listenersInitialized = false;

function initListeners(
  setWaveform: (waveform: number[]) => void,
  setStatus: (status: DictationStore["status"]) => void,
) {
  if (listenersInitialized) return;
  listenersInitialized = true;

  listen<number[]>("dictation:waveform", (event) => {
    setWaveform(event.payload);
  }).then((unlisten) => eventListeners.push(unlisten));

  listen<string>("dictation:status", (event) => {
    const s = event.payload as DictationStore["status"];
    setStatus(s);
  }).then((unlisten) => eventListeners.push(unlisten));

  // Model download progress events — stored in case UI needs it later
  listen<{ size: string; progress: number }>("dictation:model-progress", () => {
    // Progress tracking can be extended here if needed
  }).then((unlisten) => eventListeners.push(unlisten));
}

export const useDictationStore = create<DictationStore>((set, get) => {
  // Initialize event listeners with store setters
  initListeners(
    (waveform) => set({ waveform }),
    (status) => set({ status }),
  );

  return {
    isRecording: false,
    isTranscribing: false,
    waveform: [],
    lastResult: null,
    status: "idle",
    error: null,

    history: [],
    analytics: null,
    settings: null,
    models: [],

    async startRecording(deviceIndex?: number) {
      // Idempotent: in-window hotkey + OS-global hotkey can both fire for the same press.
      const state = get();
      if (state.isRecording || state.isTranscribing) return;
      try {
        set({ error: null, status: "recording", lastResult: null, waveform: [] });
        await startRecordingCmd(deviceIndex);
        set({ isRecording: true });
      } catch (err) {
        set({ error: String(err), status: "error", isRecording: false });
      }
    },

    async stopRecording() {
      // Idempotent: skip if not actively recording (double-fire on key release / abort)
      if (!get().isRecording) return get().lastResult ?? "";
      try {
        set({ isRecording: false, isTranscribing: true, status: "transcribing" });
        const result = await stopRecordingCmd();
        set({ lastResult: result, isTranscribing: false, status: "done", waveform: [] });
        return result;
      } catch (err) {
        set({ error: String(err), status: "error", isTranscribing: false });
        return "";
      }
    },

    async loadHistory(limit = 50, offset = 0) {
      try {
        const raw = await getDictationHistory(limit, offset);
        const entries: DictationEntry[] = JSON.parse(raw);
        set({ history: entries });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    async searchHistory(query: string) {
      try {
        const raw = await searchDictationHistory(query);
        const entries: DictationEntry[] = JSON.parse(raw);
        set({ history: entries });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    async loadAnalytics() {
      try {
        const raw = await getDictationAnalytics();
        const analytics: DictationAnalytics = JSON.parse(raw);
        set({ analytics });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    async loadSettings() {
      try {
        const raw = await getDictationSettings();
        const settings: DictationSettings = JSON.parse(raw);
        set({ settings });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    async updateSettings(settings: DictationSettings) {
      try {
        await setDictationSettings(JSON.stringify(settings));
        set({ settings });
      } catch (err) {
        set({ error: String(err) });
      }
    },

    async loadModels() {
      try {
        const raw = await listWhisperModels();
        // Tauri returns the Vec directly as a parsed array, not a JSON string
        const models: WhisperModel[] = typeof raw === "string" ? JSON.parse(raw) : raw;
        set({ models });
      } catch (err) {
        set({ error: String(err), models: [] });
      }
    },

    async downloadModel(size: string) {
      try {
        await downloadWhisperModelCmd(size);
        // Reload models after download completes
        await get().loadModels();
      } catch (err) {
        set({ error: String(err) });
      }
    },

    clearResult() {
      set({ lastResult: null, status: "idle", error: null, waveform: [] });
    },
  };
});
