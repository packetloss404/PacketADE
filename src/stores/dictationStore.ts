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
  cancelRecordingCmd,
  getDictationHistory,
  getDictationAnalytics,
  searchDictationHistory,
  getDictationSettings,
  setDictationSettings,
  downloadWhisperModel as downloadWhisperModelCmd,
  listWhisperModels,
} from "@/lib/tauri";

interface DictationStore {
  isStarting: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  waveform: number[];
  lastResult: string | null;
  status: "idle" | "starting" | "recording" | "transcribing" | "done" | "error";
  error: string | null;
  deliveryNotice: string | null;

  history: DictationEntry[];
  analytics: DictationAnalytics | null;
  settings: DictationSettings | null;
  models: WhisperModel[];
  modelProgress: Record<string, number>;

  startRecording: (deviceIndex?: number) => Promise<void>;
  stopRecording: () => Promise<string>;
  cancelRecording: () => Promise<void>;
  loadHistory: (limit?: number, offset?: number) => Promise<void>;
  searchHistory: (query: string) => Promise<void>;
  loadAnalytics: () => Promise<void>;
  loadSettings: () => Promise<void>;
  updateSettings: (settings: DictationSettings) => Promise<void>;
  loadModels: () => Promise<void>;
  downloadModel: (size: string) => Promise<void>;
  clearResult: () => void;
  setDeliveryNotice: (notice: string | null) => void;
}

// Set up global event listeners once
const eventListeners: UnlistenFn[] = [];
let listenersInitialized = false;
let pendingStartAction: "stop" | "cancel" | null = null;

function initListeners(
  setWaveform: (waveform: number[]) => void,
  setStatus: (status: DictationStore["status"]) => void,
  setError: (error: string) => void,
  setModelProgress: (size: string, percent: number) => void,
) {
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (listenersInitialized || !tauriAvailable) return;
  listenersInitialized = true;

  listen<number[] | { bars: number[] }>("dictation:waveform", (event) => {
    // Accept the pre-fix `{ bars }` payload during hot reloads as well as the
    // canonical array emitted by the repaired backend.
    const payload = event.payload;
    setWaveform(Array.isArray(payload) ? payload : payload.bars);
  }).then((unlisten) => eventListeners.push(unlisten));

  listen<string>("dictation:error", (event) => {
    setError(event.payload);
    // Capture callbacks cannot drop their own CPAL stream safely. Once the
    // error reaches the UI thread, release the native handle and audio buffer.
    void cancelRecordingCmd().catch((cleanupError) =>
      console.warn("[dictation] failed to clean up errored capture:", cleanupError),
    );
  }).then((unlisten) => eventListeners.push(unlisten));

  listen<string>("dictation:status", (event) => {
    const s = event.payload as DictationStore["status"];
    setStatus(s);
  }).then((unlisten) => eventListeners.push(unlisten));

  // Model download progress events — stored in case UI needs it later
  listen<{ size: string; percent: number }>("dictation:model-progress", (event) => {
    setModelProgress(event.payload.size, event.payload.percent);
  }).then((unlisten) => eventListeners.push(unlisten));
}

export const useDictationStore = create<DictationStore>((set, get) => {
  // Initialize event listeners with store setters
  initListeners(
    (waveform) => set({ waveform }),
    (status) => set({ status }),
    (error) =>
      set({
        error,
        status: "error",
        isStarting: false,
        isRecording: false,
        isTranscribing: false,
      }),
    (size, percent) =>
      set((state) => ({
        modelProgress: { ...state.modelProgress, [size]: percent },
      })),
  );

  return {
    isStarting: false,
    isRecording: false,
    isTranscribing: false,
    waveform: [],
    lastResult: null,
    status: "idle",
    error: null,
    deliveryNotice: null,

    history: [],
    analytics: null,
    settings: null,
    models: [],
    modelProgress: {},

    async startRecording(deviceIndex?: number) {
      // Idempotent: in-window hotkey + OS-global hotkey can both fire for the same press.
      const state = get();
      if (state.isStarting || state.isRecording || state.isTranscribing) return;
      try {
        set({
          isStarting: true,
          error: null,
          status: "starting",
          lastResult: null,
          deliveryNotice: null,
          waveform: [],
        });

        if (!get().settings) await get().loadSettings();
        if (get().models.length === 0) await get().loadModels();

        const current = get();
        const selectedModel = current.models.find(
          (model) => model.size === current.settings?.modelSize,
        );
        if (!selectedModel?.downloaded) {
          throw new Error(
            "No verified Whisper model is selected. Open Tools → Dictation, choose a Ready model, or download one.",
          );
        }

        await startRecordingCmd(deviceIndex ?? current.settings?.deviceIndex ?? undefined);
        set({ isStarting: false, isRecording: true, status: "recording" });
        const pending = pendingStartAction;
        pendingStartAction = null;
        if (pending === "cancel") {
          await get().cancelRecording();
        } else if (pending === "stop") {
          await get().stopRecording();
        }
      } catch (err) {
        pendingStartAction = null;
        set({
          error: String(err),
          status: "error",
          isStarting: false,
          isRecording: false,
        });
      }
    },

    async stopRecording() {
      if (get().isStarting) {
        pendingStartAction = "stop";
        return "";
      }
      // Idempotent: skip if not actively recording (double-fire on key release / abort)
      if (!get().isRecording) return get().lastResult ?? "";
      try {
        set({ isRecording: false, isTranscribing: true, status: "transcribing" });
        const result = await stopRecordingCmd();
        set({ lastResult: result, isTranscribing: false, status: "done", waveform: [] });
        await Promise.all([get().loadHistory(100, 0), get().loadAnalytics()]);
        return result;
      } catch (err) {
        set({ error: String(err), status: "error", isTranscribing: false });
        return "";
      }
    },

    async cancelRecording() {
      if (get().isStarting) {
        pendingStartAction = "cancel";
        return;
      }
      if (!get().isRecording) return;
      try {
        await cancelRecordingCmd();
        set({
          isStarting: false,
          isRecording: false,
          isTranscribing: false,
          status: "idle",
          waveform: [],
          lastResult: null,
          error: null,
        });
      } catch (err) {
        set({
          isRecording: false,
          status: "error",
          waveform: [],
          error: String(err),
        });
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
        const parsed = JSON.parse(raw) as Partial<DictationSettings>;
        const settings: DictationSettings = {
          modelSize: parsed.modelSize ?? "small",
          deviceIndex: parsed.deviceIndex ?? null,
          customDictionary: parsed.customDictionary ?? [],
          autoPaste: parsed.autoPaste ?? false,
          language: parsed.language ?? "auto",
          systemWidePaste: parsed.systemWidePaste ?? false,
          pushToTalkShortcut: parsed.pushToTalkShortcut,
          toggleShortcut: parsed.toggleShortcut,
        };
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
        set((state) => ({
          error: null,
          modelProgress: { ...state.modelProgress, [size]: 0 },
        }));
        await downloadWhisperModelCmd(size);
        // Reload models after download completes
        await get().loadModels();
      } catch (err) {
        set((state) => {
          const modelProgress = { ...state.modelProgress };
          delete modelProgress[size];
          return { error: String(err), modelProgress };
        });
      }
    },

    clearResult() {
      set({
        lastResult: null,
        status: "idle",
        error: null,
        deliveryNotice: null,
        waveform: [],
      });
    },

    setDeliveryNotice(notice) {
      set({ deliveryNotice: notice });
    },
  };
});
