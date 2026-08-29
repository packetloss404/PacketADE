import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DictationEntry,
  DictationAnalytics,
  DictationResult,
  DictationSettings,
  DictationShortcutStatus,
  WhisperModel,
} from "@/types/dictation";
import { MAX_WORD_GOAL } from "@/types/dictation";
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
  deleteDictationEntry as deleteDictationEntryCmd,
  clearDictationHistory as clearDictationHistoryCmd,
} from "@/lib/tauri";

interface DictationStore {
  isStarting: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  waveform: number[];
  lastResult: string | null;
  lastTelemetry: DictationResult | null;
  status: "idle" | "starting" | "recording" | "transcribing" | "done" | "error";
  error: string | null;
  deliveryNotice: string | null;
  shortcutStatus: DictationShortcutStatus;

  /**
   * Monotonic id of the current capture attempt. Bumped by `startRecording`,
   * by `cancelRecording`, by the `dictation:error` listener, and by the
   * watchdogs. Every async continuation re-reads it before writing, so a
   * response that arrives after its capture was abandoned is discarded instead
   * of resurrecting a dead recording (or delivering a stale transcript).
   */
  captureId: number;
  /** `captureId` that produced `lastResult`. Consumers correlate delivery
   *  against this rather than diffing the transcript string — two identical
   *  utterances in a row are otherwise indistinguishable. */
  lastResultCaptureId: number | null;

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
  /** Delete one transcript. Resolves `true` when the row is gone. */
  deleteEntry: (id: number) => Promise<boolean>;
  /** Delete every transcript. Resolves with the number of rows removed, or
   *  `null` when the sweep failed. */
  clearHistory: () => Promise<number | null>;
  loadAnalytics: () => Promise<void>;
  loadSettings: () => Promise<void>;
  updateSettings: (settings: DictationSettings) => Promise<void>;
  loadModels: () => Promise<void>;
  downloadModel: (size: string) => Promise<void>;
  clearResult: () => void;
  setDeliveryNotice: (notice: string | null) => void;
  setShortcutStatus: (status: DictationShortcutStatus) => void;
}

type StoreSet = (
  partial:
    | Partial<DictationStore>
    | ((state: DictationStore) => Partial<DictationStore>),
) => void;
type StoreGet = () => DictationStore;

/**
 * Watchdog bounds. The Rust side can wedge without ever answering: CPAL device
 * enumeration blocks when a Bluetooth microphone vanishes mid-call, and the
 * whisper worker can stall on a corrupt model. Without a timeout the store
 * keeps `isStarting`/`isTranscribing` true forever, and because
 * `startRecording` refuses to re-enter while either is set, push-to-talk goes
 * permanently dead with a recording indicator that never resolves.
 */
const START_TIMEOUT_MS = 15_000;
const TRANSCRIBE_MIN_TIMEOUT_MS = 90_000;
const TRANSCRIBE_MAX_TIMEOUT_MS = 15 * 60_000;
/** Whisper runs well under realtime on CPU; 20x the recorded length plus the
 *  90s floor (model load from cold disk) is slack, not a deadline. */
const TRANSCRIBE_REALTIME_FACTOR = 20;

/** Shipped word-goal defaults. Mirrors `DEFAULT_DAILY_WORD_GOAL` /
 *  `DEFAULT_WEEKLY_WORD_GOAL` in `src-tauri/src/commands/dictation/config.rs`;
 *  used only when the stored config has no usable value. */
export const DEFAULT_DAILY_WORD_GOAL = 500;
export const DEFAULT_WEEKLY_WORD_GOAL = 2_500;

/** Coerce a stored word goal. Negative and non-finite values are not "no
 *  goal", they are corruption, so they take the default; a real `0` is kept. */
function wordGoal(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(MAX_WORD_GOAL, Math.floor(value));
}

class DictationTimeoutError extends Error {}

function transcribeTimeoutMs(recordedMs: number): number {
  return Math.min(
    TRANSCRIBE_MAX_TIMEOUT_MS,
    Math.max(TRANSCRIBE_MIN_TIMEOUT_MS, recordedMs * TRANSCRIBE_REALTIME_FACTOR),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DictationTimeoutError(message)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// Set up global event listeners once
const eventListeners: UnlistenFn[] = [];
let listenersInitialized = false;
/** A push-to-talk release (or Escape) that lands before the microphone has
 *  finished opening. Tagged with the capture it belongs to so an abandoned
 *  start cannot hand its queued action to the *next* capture. */
let pendingStartAction: { captureId: number; action: "stop" | "cancel" } | null = null;
/** Wall-clock start of the live capture, used only to size the transcription
 *  watchdog. Cleared on every terminal transition. */
let recordingStartedAt: number | null = null;

/** Read-and-clear. Kept as a function so the value is re-read across the
 *  `await` in `startRecording` (a direct read is narrowed to the `null` the
 *  same function assigned before awaiting). */
function takePendingStartAction(captureId: number): "stop" | "cancel" | null {
  const pending = pendingStartAction;
  pendingStartAction = null;
  return pending && pending.captureId === captureId ? pending.action : null;
}

function track(pending: Promise<UnlistenFn>, event: string) {
  void pending
    .then((unlisten) => eventListeners.push(unlisten))
    .catch((error) =>
      console.warn(`[dictation] failed to subscribe to ${event}:`, error),
    );
}

function initListeners(set: StoreSet, get: StoreGet) {
  const tauriAvailable =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (listenersInitialized || !tauriAvailable) return;
  listenersInitialized = true;

  track(
    listen<number[] | { bars: number[] } | null>("dictation:waveform", (event) => {
      // Accept the pre-fix `{ bars }` payload during hot reloads as well as the
      // canonical array emitted by the repaired backend. A malformed payload
      // must not throw inside the listener — an exception here kills the frame
      // and, in the `{ bars }` branch, used to be a hard TypeError on null.
      const payload = event.payload;
      if (Array.isArray(payload)) set({ waveform: payload });
      else if (payload && Array.isArray(payload.bars)) set({ waveform: payload.bars });
    }),
    "dictation:waveform",
  );

  track(
    listen<string>("dictation:error", (event) => {
      // Device loss mid-capture lands here (the CPAL error callback). The
      // backend records a `capture_error` breadcrumb before clearing
      // `is_recording`, so `stop_recording` still accepts the capture,
      // transcribes whatever was spoken before the device vanished, and returns
      // the device error as a `warnings` entry. Cancelling instead would drop
      // that buffer, so the words the user already spoke are only reachable
      // through stop.
      //
      // The original reasoning still holds: a capture callback cannot drop its
      // own CPAL stream, so the UI thread has to release the native handle.
      // `stop_recording` tears the stream down under the stream lock exactly
      // like `cancel_recording` does, so stop releases the handle *and* keeps
      // the audio — cancel is now reserved for the case with nothing to save.
      const message = event.payload;
      const state = get();
      pendingStartAction = null;

      if (state.isRecording) {
        // No start is in flight, so the generation must NOT be retired here:
        // the salvage stop's transcript has to stay eligible for delivery, and
        // the surface that owns this capture has to stay its owner.
        set({ error: null, deliveryNotice: message, waveform: [] });
        void get().stopRecording();
        return;
      }

      if (state.isStarting) {
        // Retire the generation so the in-flight `start_recording` response is
        // discarded and can never repaint "recording" over a dead stream, then
        // hand the salvage stop a capture of its own. `isRecording` is set only
        // as that hand-off: `stopRecording` runs synchronously on the next line
        // and moves it straight to `transcribing`.
        recordingStartedAt = recordingStartedAt ?? Date.now();
        set((current) => ({
          captureId: current.captureId + 1,
          isStarting: false,
          isRecording: true,
          isTranscribing: false,
          error: null,
          deliveryNotice: message,
          waveform: [],
        }));
        void get().stopRecording();
        return;
      }

      if (state.isTranscribing) {
        // The stop is already in flight and will collect `capture_error` as a
        // warning itself. Cancelling here would clear that breadcrumb and
        // retire the generation, throwing away the very result being salvaged.
        set({ deliveryNotice: message });
        return;
      }

      // Nothing in flight and nothing to salvage: surface the failure and
      // release any native handle the backend is still holding.
      recordingStartedAt = null;
      set((current) => ({
        captureId: current.captureId + 1,
        error: message,
        status: "error",
        isStarting: false,
        isRecording: false,
        isTranscribing: false,
        waveform: [],
      }));
      void cancelRecordingCmd().catch((cleanupError) =>
        console.warn("[dictation] failed to clean up errored capture:", cleanupError),
      );
    }),
    "dictation:error",
  );

  track(
    listen<string>("dictation:status", (event) => {
      // The backend only ever emits `idle` (from `cancel_recording`) and
      // `transcribing` (from `stop_recording`), and the frontend is always the
      // caller of both — so this event never carries state the store does not
      // already have. It is applied only where it agrees with the store.
      // Blindly assigning it was a live desync: the `dictation:error` handler
      // calls `cancel_recording`, whose `idle` echo used to repaint the UI as
      // idle and hide the device-loss error the user needs to see; and a late
      // `idle` arriving after the next capture had begun cleared `isRecording`
      // out from under a live stream.
      const next = event.payload as DictationStore["status"];
      set((state) => {
        if (next === "transcribing") {
          return state.isTranscribing ? { status: "transcribing" as const } : {};
        }
        if (next === "idle") {
          if (state.isStarting || state.isRecording || state.isTranscribing) return {};
          if (state.status === "error") return {};
          return { status: "idle" as const };
        }
        return {};
      });
    }),
    "dictation:status",
  );

  track(
    listen<string>("dictation:warning", (event) => {
      // Recoverable conditions only: a microphone-selection fallback, or the
      // stall watch noticing a Bluetooth link that has gone quiet without
      // raising a stream error. Deliberately NOT capture-ending — a stall can
      // recover, and tearing the capture down here would cost the user the
      // buffer they have already spoken into. The backend also folds the same
      // text onto the result's `warnings`, so it survives into the transcript.
      set({ deliveryNotice: event.payload });
    }),
    "dictation:warning",
  );

  track(
    listen("dictation:limit-reached", () => {
      const state = get();
      if (state.isStarting || state.isRecording) {
        set({ deliveryNotice: "Maximum recording duration reached; transcribing now." });
        void state.stopRecording();
      }
    }),
    "dictation:limit-reached",
  );

  // Model download progress events — stored in case UI needs it later
  track(
    listen<{ size: string; percent: number }>("dictation:model-progress", (event) => {
      set((state) => ({
        modelProgress: { ...state.modelProgress, [event.payload.size]: event.payload.percent },
      }));
    }),
    "dictation:model-progress",
  );
}

export const useDictationStore = create<DictationStore>((set, get) => {
  // Initialize event listeners with store setters
  initListeners(set, get);

  return {
    isStarting: false,
    isRecording: false,
    isTranscribing: false,
    waveform: [],
    lastResult: null,
    lastTelemetry: null,
    status: "idle",
    error: null,
    deliveryNotice: null,
    shortcutStatus: {
      state: "disabled",
      message: "Global dictation shortcuts are off.",
    },

    captureId: 0,
    lastResultCaptureId: null,

    history: [],
    analytics: null,
    settings: null,
    models: [],
    modelProgress: {},

    async startRecording(deviceIndex?: number) {
      // Idempotent: in-window hotkey + OS-global hotkey can both fire for the same press.
      const state = get();
      if (state.isStarting || state.isRecording || state.isTranscribing) return;
      const captureId = state.captureId + 1;
      pendingStartAction = null;
      recordingStartedAt = null;
      try {
        set({
          captureId,
          isStarting: true,
          error: null,
          status: "starting",
          lastResult: null,
          lastTelemetry: null,
          lastResultCaptureId: null,
          deliveryNotice: null,
          waveform: [],
        });

        if (!get().settings) await get().loadSettings();
        if (get().captureId !== captureId) return;
        if (get().models.length === 0) await get().loadModels();
        if (get().captureId !== captureId) return;

        const current = get();
        const selectedModel = current.models.find(
          (model) => model.size === current.settings?.modelSize,
        );
        if (!selectedModel?.downloaded) {
          throw new Error(
            "No verified Whisper model is selected. Open Tools → Dictation, choose a Ready model, or download one.",
          );
        }

        await withTimeout(
          startRecordingCmd(
            current.settings?.deviceId,
            deviceIndex ?? current.settings?.deviceIndex,
          ),
          START_TIMEOUT_MS,
          "The microphone did not open in time. It may have been disconnected — pick a device in Tools → Dictation and try again.",
        );
        // A device error (or an explicit cancel) can land while the microphone
        // is still opening. Without this check the resolved start would repaint
        // "recording" over an error the user already saw, leaving an indicator
        // that no longer corresponds to a live stream.
        if (get().captureId !== captureId) return;
        recordingStartedAt = Date.now();
        set({ isStarting: false, isRecording: true, status: "recording" });
        const pending = takePendingStartAction(captureId);
        if (pending === "cancel") {
          await get().cancelRecording();
        } else if (pending === "stop") {
          await get().stopRecording();
        }
      } catch (err) {
        pendingStartAction = null;
        recordingStartedAt = null;
        // A newer capture (or the error listener's more specific message)
        // already owns the store; do not clobber it.
        if (get().captureId !== captureId) return;
        if (err instanceof DictationTimeoutError) {
          // The Rust command may still complete and hold a live CPAL stream.
          // Tell it to drop the device so the microphone is not left hot.
          void cancelRecordingCmd().catch(() => {});
        }
        set({
          error: String(err),
          status: "error",
          isStarting: false,
          isRecording: false,
          isTranscribing: false,
          waveform: [],
        });
      }
    },

    async stopRecording() {
      const state = get();
      if (state.isStarting) {
        pendingStartAction = { captureId: state.captureId, action: "stop" };
        return "";
      }
      // Idempotent: skip if not actively recording (double-fire on key release
      // / abort). Returning `lastResult` here replayed the *previous*
      // transcript to the composer, which inserted the same text twice.
      if (!state.isRecording) return "";
      const captureId = state.captureId;
      const recordedMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
      recordingStartedAt = null;
      try {
        set({ isRecording: false, isTranscribing: true, status: "transcribing" });
        const payload = await withTimeout(
          stopRecordingCmd(),
          transcribeTimeoutMs(recordedMs),
          "Transcription did not finish in time. The audio was discarded; try a shorter recording or a smaller Whisper model.",
        );
        // Cancelled, or the device died while whisper was running. Dropping the
        // text here is deliberate: the user has moved on and delivering it now
        // would paste into whatever they are doing instead.
        if (get().captureId !== captureId) return "";
        // Accept a plain string from a pre-upgrade backend during dev hot reload.
        const telemetry = typeof payload === "string" ? null : payload;
        const result = typeof payload === "string" ? payload : payload.text;
        // Surface EVERY warning. A single capture legitimately carries more
        // than one — a device-selection fallback at start plus a stall or
        // disconnect notice folded in at stop — and showing only the first hid
        // the reason the transcript was cut short.
        const warnings = telemetry?.warnings ?? [];
        set((prev) => ({
          lastResult: result,
          lastResultCaptureId: captureId,
          lastTelemetry: telemetry,
          isTranscribing: false,
          status: "done" as const,
          waveform: [],
          // `startRecording` clears the notice, so anything still on screen was
          // emitted by THIS capture (a live `dictation:warning` stall notice).
          // Keep it when the result carries no warnings of its own.
          deliveryNotice: warnings.length > 0 ? warnings.join(" ") : prev.deliveryNotice,
        }));
        await Promise.all([get().loadHistory(100, 0), get().loadAnalytics()]);
        return result;
      } catch (err) {
        if (get().captureId !== captureId) return "";
        set({
          error: String(err),
          status: "error",
          isStarting: false,
          isRecording: false,
          isTranscribing: false,
          waveform: [],
        });
        return "";
      }
    },

    async cancelRecording() {
      const state = get();
      if (state.isStarting) {
        // The microphone is still opening; there is no backend stream to drop
        // yet. `startRecording` applies this once the device is live.
        pendingStartAction = { captureId: state.captureId, action: "cancel" };
        return;
      }
      // Always reach the backend and always reset locally. This used to return
      // early whenever `isRecording` was false, which meant Escape could not
      // clear a wedged `transcribing` spinner and a desynced backend kept the
      // microphone open with no way for the UI to release it.
      const inFlight = state.isRecording || state.isTranscribing;
      pendingStartAction = null;
      recordingStartedAt = null;
      set((current) => ({
        // Retire the generation so an in-flight `stop_recording` response is
        // discarded instead of arriving as a transcript after the cancel.
        captureId: current.captureId + 1,
        isStarting: false,
        isRecording: false,
        isTranscribing: false,
        status: "idle",
        waveform: [],
        error: null,
        // A cancel with nothing in flight is a state reset, not a discard: it
        // must not wipe a transcript the user is still reading.
        ...(inFlight
          ? { lastResult: null, lastTelemetry: null, lastResultCaptureId: null }
          : {}),
      }));
      try {
        await cancelRecordingCmd();
      } catch (err) {
        set({ status: "error", error: String(err) });
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

    /**
     * Delete one transcript.
     *
     * The row is dropped from `history` only AFTER the backend confirms, and
     * analytics are refetched rather than adjusted locally: every one of the
     * twenty-one derived figures (streaks, vocabulary first-seen days, n-gram
     * ranks) depends on the full corpus, so there is no correct local edit.
     */
    async deleteEntry(id: number) {
      try {
        await deleteDictationEntryCmd(id);
        set((state) => ({
          error: null,
          history: state.history.filter((entry) => entry.id !== id),
        }));
        await get().loadAnalytics();
        return true;
      } catch (err) {
        set({ error: String(err) });
        return false;
      }
    },

    /** Delete every transcript. See {@link DictationStore.deleteEntry} for why
     *  analytics are refetched instead of recomputed. */
    async clearHistory() {
      try {
        const removed = await clearDictationHistoryCmd();
        set({ error: null, history: [] });
        await get().loadAnalytics();
        return removed;
      } catch (err) {
        set({ error: String(err) });
        return null;
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
        // DV13: the opt-in flags are compared against `true` rather than
        // coerced. A corrupt or hand-edited config holding `"false"`, `1`, or
        // `{}` would otherwise read as truthy and implicitly arm OS-global
        // shortcuts / system-wide paste that the user never enabled.
        const accelerator = (value: unknown) =>
          typeof value === "string" && value.trim().length > 0 ? value : undefined;
        const settings: DictationSettings = {
          modelSize: typeof parsed.modelSize === "string" ? parsed.modelSize : "small",
          deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : null,
          deviceIndex:
            typeof parsed.deviceIndex === "number" ? parsed.deviceIndex : null,
          customDictionary: Array.isArray(parsed.customDictionary)
            ? parsed.customDictionary
            : [],
          autoPaste: parsed.autoPaste === true,
          language: typeof parsed.language === "string" ? parsed.language : "auto",
          systemWidePaste: parsed.systemWidePaste === true,
          pushToTalkShortcut: accelerator(parsed.pushToTalkShortcut),
          toggleShortcut: accelerator(parsed.toggleShortcut),
          globalShortcutsEnabled: parsed.globalShortcutsEnabled === true,
          maxDurationSeconds: Math.min(
            1_800,
            Math.max(
              10,
              typeof parsed.maxDurationSeconds === "number" &&
                Number.isFinite(parsed.maxDurationSeconds)
                ? parsed.maxDurationSeconds
                : 300,
            ),
          ),
          // `0` is meaningful ("no goal"), so an absent/garbage value falls
          // back to the shipped default rather than to 0 — otherwise a config
          // written before the goals existed would silently hide both charts.
          dailyWordGoal: wordGoal(parsed.dailyWordGoal, DEFAULT_DAILY_WORD_GOAL),
          weeklyWordGoal: wordGoal(parsed.weeklyWordGoal, DEFAULT_WEEKLY_WORD_GOAL),
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
        lastTelemetry: null,
        lastResultCaptureId: null,
        status: "idle",
        error: null,
        deliveryNotice: null,
        waveform: [],
      });
    },

    setDeliveryNotice(notice) {
      set({ deliveryNotice: notice });
    },

    setShortcutStatus(shortcutStatus) {
      set({ shortcutStatus });
    },
  };
});
