import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  startRecordingCmd: vi.fn(),
  stopRecordingCmd: vi.fn(),
  cancelRecordingCmd: vi.fn(),
  getDictationHistory: vi.fn(),
  getDictationAnalytics: vi.fn(),
  searchDictationHistory: vi.fn(),
  getDictationSettings: vi.fn(),
  setDictationSettings: vi.fn(),
  downloadWhisperModel: vi.fn(),
  deleteWhisperModel: vi.fn(),
  listWhisperModels: vi.fn(),
  deleteDictationEntry: vi.fn(),
  clearDictationHistory: vi.fn(),
}));

// The store only subscribes to backend events when Tauri is present, so make it
// look present before the module under test is imported. Handlers are captured
// so the tests can play the backend's side of the contract (device loss, the
// `idle` status echo, malformed waveform frames).
const backendEvents = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  return new Map<string, (event: { payload: unknown }) => void>();
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    backendEvents.set(name, handler);
    return Promise.resolve(() => backendEvents.delete(name));
  }),
}));

vi.mock("@/lib/tauri", () => tauriMocks);

import { useDictationStore } from "../dictationStore";

function emit(name: string, payload: unknown) {
  const handler = backendEvents.get(name);
  if (!handler) throw new Error(`no listener registered for ${name}`);
  handler({ payload });
}

/** Drain the pending microtask queue; safe under fake timers. */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const readyModel = {
  size: "base",
  downloaded: true,
  installed: true,
  fileSizeMb: 142,
  diskBytes: 147_964_211,
  path: "C:\\models\\ggml-base.bin",
};
const dictationResult = {
  text: "hello",
  durationSeconds: 1.2,
  inputSampleRate: 48_000,
  channels: 2,
  sampleFormat: "f32",
  deviceName: "Test microphone",
  deviceId: "wasapi:test",
  modelSize: "base",
  detectedLanguage: "en",
  modelLoadMs: 20,
  inferenceMs: 80,
  warnings: [] as string[],
};

describe("dictationStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.getDictationSettings.mockResolvedValue(
      JSON.stringify({
        modelSize: "base",
        deviceId: null,
        deviceIndex: 2,
        customDictionary: [],
        autoPaste: true,
      }),
    );
    tauriMocks.listWhisperModels.mockResolvedValue([readyModel]);
    tauriMocks.startRecordingCmd.mockResolvedValue(undefined);
    tauriMocks.stopRecordingCmd.mockResolvedValue(dictationResult);
    tauriMocks.cancelRecordingCmd.mockResolvedValue(undefined);
    tauriMocks.getDictationHistory.mockResolvedValue("[]");
    tauriMocks.deleteDictationEntry.mockResolvedValue(undefined);
    tauriMocks.clearDictationHistory.mockResolvedValue(0);
    tauriMocks.getDictationAnalytics.mockResolvedValue(
      JSON.stringify({
        totalEntries: 0,
        totalWords: 0,
        averageWpm: 0,
        fastestWpm: 0,
        averageSentiment: 0,
        totalDurationMinutes: 0,
        longestEntryWords: 0,
        hourlyActivity: Array(24).fill(0),
        topWords: [],
        modeBreakdown: {},
        vocabularyDiversity: 0,
        dailyStreak: 0,
        timeSavedMinutes: 0,
      }),
    );
    useDictationStore.setState({
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
      settings: null,
      models: [],
      modelProgress: {},
      history: [],
      analytics: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("migrates missing settings fields and uses the saved microphone", async () => {
    await useDictationStore.getState().startRecording();

    expect(useDictationStore.getState().settings).toMatchObject({
      language: "auto",
      systemWidePaste: false,
      globalShortcutsEnabled: false,
      maxDurationSeconds: 300,
    });
    expect(tauriMocks.startRecordingCmd).toHaveBeenCalledWith(null, 2);
    expect(useDictationStore.getState().status).toBe("recording");
  });

  it("queues a quick push-to-talk release while the microphone is opening", async () => {
    let finishStart!: () => void;
    tauriMocks.startRecordingCmd.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );

    const start = useDictationStore.getState().startRecording();
    await vi.waitFor(() => expect(tauriMocks.startRecordingCmd).toHaveBeenCalledTimes(1));
    const stop = useDictationStore.getState().stopRecording();
    finishStart();
    await Promise.all([start, stop]);

    expect(tauriMocks.stopRecordingCmd).toHaveBeenCalledTimes(1);
    expect(useDictationStore.getState()).toMatchObject({
      isStarting: false,
      isRecording: false,
      isTranscribing: false,
      lastResult: "hello",
      lastTelemetry: dictationResult,
      status: "done",
    });
  });

  it("cancels without transcribing", async () => {
    useDictationStore.setState({ isRecording: true, status: "recording" });

    await useDictationStore.getState().cancelRecording();

    expect(tauriMocks.cancelRecordingCmd).toHaveBeenCalledTimes(1);
    expect(tauriMocks.stopRecordingCmd).not.toHaveBeenCalled();
    expect(useDictationStore.getState().status).toBe("idle");
  });

  // --- stuck-state recovery -------------------------------------------------

  it("salvages the partial audio when the microphone dies mid-capture", async () => {
    tauriMocks.stopRecordingCmd.mockResolvedValue({
      ...dictationResult,
      text: "the words already spoken",
      warnings: [
        "Fell back to the default microphone.",
        "Microphone stream stopped unexpectedly: device lost",
      ],
    });

    await useDictationStore.getState().startRecording();
    const captureId = useDictationStore.getState().captureId;

    emit("dictation:error", "Microphone stream stopped unexpectedly: device lost");
    await vi.waitFor(() => expect(useDictationStore.getState().status).toBe("done"));

    // Cancel drops the backend buffer; only stop can claim the partial audio.
    expect(tauriMocks.stopRecordingCmd).toHaveBeenCalledTimes(1);
    expect(tauriMocks.cancelRecordingCmd).not.toHaveBeenCalled();
    expect(useDictationStore.getState()).toMatchObject({
      isRecording: false,
      isTranscribing: false,
      lastResult: "the words already spoken",
    });
    // The generation is deliberately NOT retired here, so the salvaged
    // transcript stays eligible for delivery to the armed target.
    expect(useDictationStore.getState().lastResultCaptureId).toBe(captureId);
    // Both warnings reach the user, not just the first.
    expect(useDictationStore.getState().deliveryNotice).toContain("default microphone");
    expect(useDictationStore.getState().deliveryNotice).toContain("device lost");
  });

  it("lets an in-flight transcription collect the device error itself", async () => {
    let finishStop!: (value: typeof dictationResult) => void;
    tauriMocks.stopRecordingCmd.mockImplementation(
      () =>
        new Promise<typeof dictationResult>((resolve) => {
          finishStop = resolve;
        }),
    );

    await useDictationStore.getState().startRecording();
    const stop = useDictationStore.getState().stopRecording();
    await vi.waitFor(() => expect(useDictationStore.getState().isTranscribing).toBe(true));

    emit("dictation:error", "Microphone stream stopped unexpectedly: device lost");
    // Cancelling here would clear the backend breadcrumb and retire the
    // generation, discarding the very result being salvaged.
    expect(tauriMocks.cancelRecordingCmd).not.toHaveBeenCalled();

    finishStop({
      ...dictationResult,
      warnings: ["Microphone stream stopped unexpectedly: device lost"],
    });
    await expect(stop).resolves.toBe("hello");
    expect(useDictationStore.getState().lastResult).toBe("hello");
    expect(useDictationStore.getState().deliveryNotice).toContain("device lost");
  });

  it("discards a stale start response but still salvages the capture", async () => {
    let finishStart!: () => void;
    tauriMocks.startRecordingCmd.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );

    const start = useDictationStore.getState().startRecording();
    await vi.waitFor(() => expect(tauriMocks.startRecordingCmd).toHaveBeenCalledTimes(1));

    // Bluetooth headset drops while the stream is still opening.
    emit("dictation:error", "Microphone stream stopped unexpectedly: device lost");
    await vi.waitFor(() => expect(useDictationStore.getState().status).toBe("done"));

    finishStart();
    await start;

    // The resolved start belongs to a retired generation: it must never repaint
    // a live recording over a stream that already died.
    expect(useDictationStore.getState()).toMatchObject({
      isStarting: false,
      isRecording: false,
      isTranscribing: false,
      status: "done",
    });
    expect(tauriMocks.cancelRecordingCmd).not.toHaveBeenCalled();
  });

  it("keeps the device-loss error visible when the backend echoes its idle status", () => {
    // Nothing in flight: there is no buffer to salvage, so the handle is
    // released and the failure is surfaced as an error.
    emit("dictation:error", "Microphone stream stopped unexpectedly: device lost");
    expect(tauriMocks.cancelRecordingCmd).toHaveBeenCalledTimes(1);

    emit("dictation:status", "idle");

    expect(useDictationStore.getState().status).toBe("error");
    expect(useDictationStore.getState().error).toContain("device lost");
  });

  it("treats a stall warning as recoverable rather than capture-ending", async () => {
    await useDictationStore.getState().startRecording();

    emit(
      "dictation:warning",
      "The microphone stopped delivering audio. A Bluetooth headset may have dropped its link or switched profile.",
    );

    // A stall can recover; tearing the capture down would cost the user the
    // buffer they have already spoken into.
    expect(useDictationStore.getState()).toMatchObject({
      isRecording: true,
      status: "recording",
    });
    expect(tauriMocks.cancelRecordingCmd).not.toHaveBeenCalled();
    expect(tauriMocks.stopRecordingCmd).not.toHaveBeenCalled();
    expect(useDictationStore.getState().deliveryNotice).toContain(
      "stopped delivering audio",
    );

    await useDictationStore.getState().stopRecording();
    expect(useDictationStore.getState().lastResult).toBe("hello");
    // The result carries no warnings of its own, so the live stall notice is
    // kept rather than blanked.
    expect(useDictationStore.getState().deliveryNotice).toContain(
      "stopped delivering audio",
    );
  });

  it("ignores a late backend idle echo once the next capture is live", async () => {
    await useDictationStore.getState().startRecording();

    emit("dictation:status", "idle");

    expect(useDictationStore.getState()).toMatchObject({
      isRecording: true,
      status: "recording",
    });
  });

  it("recovers from a start that never answers instead of wedging push-to-talk", async () => {
    vi.useFakeTimers();
    tauriMocks.startRecordingCmd.mockImplementation(() => new Promise<void>(() => {}));

    const start = useDictationStore.getState().startRecording();
    await flush();
    expect(useDictationStore.getState().isStarting).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    await start;

    expect(useDictationStore.getState()).toMatchObject({
      isStarting: false,
      isRecording: false,
      isTranscribing: false,
      status: "error",
    });
    expect(useDictationStore.getState().error).toContain("microphone did not open");
    // The half-open backend stream is released rather than left hot.
    expect(tauriMocks.cancelRecordingCmd).toHaveBeenCalled();

    // Push-to-talk is usable again.
    tauriMocks.startRecordingCmd.mockResolvedValue(undefined);
    vi.useRealTimers();
    await useDictationStore.getState().startRecording();
    expect(useDictationStore.getState().status).toBe("recording");
  });

  it("recovers from a transcription that never answers", async () => {
    vi.useFakeTimers();
    tauriMocks.stopRecordingCmd.mockImplementation(() => new Promise(() => {}));

    await useDictationStore.getState().startRecording();
    const stop = useDictationStore.getState().stopRecording();
    await flush();
    expect(useDictationStore.getState().isTranscribing).toBe(true);

    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await expect(stop).resolves.toBe("");

    expect(useDictationStore.getState()).toMatchObject({
      isStarting: false,
      isRecording: false,
      isTranscribing: false,
      status: "error",
    });
    expect(useDictationStore.getState().error).toContain("did not finish in time");
  });

  it("cancels a wedged transcription and discards its late result", async () => {
    let finishStop!: (value: typeof dictationResult) => void;
    tauriMocks.stopRecordingCmd.mockImplementation(
      () =>
        new Promise<typeof dictationResult>((resolve) => {
          finishStop = resolve;
        }),
    );

    await useDictationStore.getState().startRecording();
    const stop = useDictationStore.getState().stopRecording();
    await vi.waitFor(() =>
      expect(useDictationStore.getState().isTranscribing).toBe(true),
    );

    await useDictationStore.getState().cancelRecording();
    expect(useDictationStore.getState()).toMatchObject({
      isTranscribing: false,
      isRecording: false,
      status: "idle",
    });
    expect(tauriMocks.cancelRecordingCmd).toHaveBeenCalledTimes(1);

    finishStop(dictationResult);
    await expect(stop).resolves.toBe("");
    // The user moved on; delivering now would paste into whatever they are
    // doing instead.
    expect(useDictationStore.getState().lastResult).toBeNull();
  });

  it("reaches the backend on cancel even when the store thinks nothing is running", async () => {
    useDictationStore.setState({ lastResult: "keep me", status: "done" });

    await useDictationStore.getState().cancelRecording();

    expect(tauriMocks.cancelRecordingCmd).toHaveBeenCalledTimes(1);
    expect(useDictationStore.getState().status).toBe("idle");
    // A reset with nothing in flight must not destroy a transcript on screen.
    expect(useDictationStore.getState().lastResult).toBe("keep me");
  });

  it("does not replay the previous transcript on a stray stop", async () => {
    useDictationStore.setState({
      lastResult: "already inserted",
      isRecording: false,
      isTranscribing: true,
    });

    await expect(useDictationStore.getState().stopRecording()).resolves.toBe("");
    expect(tauriMocks.stopRecordingCmd).not.toHaveBeenCalled();
  });

  it("tags each transcript with its capture id", async () => {
    await useDictationStore.getState().startRecording();
    await useDictationStore.getState().stopRecording();
    const first = useDictationStore.getState().lastResultCaptureId;

    await useDictationStore.getState().startRecording();
    await useDictationStore.getState().stopRecording();
    const second = useDictationStore.getState().lastResultCaptureId;

    expect(first).not.toBeNull();
    expect(second).toBe((first as number) + 1);
  });

  it("survives a malformed waveform frame", () => {
    expect(() => emit("dictation:waveform", null)).not.toThrow();
    expect(useDictationStore.getState().waveform).toEqual([]);

    emit("dictation:waveform", { bars: [0.1, 0.2] });
    expect(useDictationStore.getState().waveform).toEqual([0.1, 0.2]);

    emit("dictation:waveform", [0.5]);
    expect(useDictationStore.getState().waveform).toEqual([0.5]);
  });

  // --- DV13: opt-in posture -------------------------------------------------

  it("keeps global shortcuts and system-wide paste off by default", async () => {
    tauriMocks.getDictationSettings.mockResolvedValue(JSON.stringify({ modelSize: "base" }));

    await useDictationStore.getState().loadSettings();

    expect(useDictationStore.getState().settings).toMatchObject({
      globalShortcutsEnabled: false,
      systemWidePaste: false,
      autoPaste: false,
    });
  });

  it("never arms global shortcuts from a non-boolean config value", async () => {
    tauriMocks.getDictationSettings.mockResolvedValue(
      JSON.stringify({
        modelSize: "base",
        globalShortcutsEnabled: "false",
        systemWidePaste: 1,
        autoPaste: "yes",
        pushToTalkShortcut: 42,
      }),
    );

    await useDictationStore.getState().loadSettings();

    expect(useDictationStore.getState().settings).toMatchObject({
      globalShortcutsEnabled: false,
      systemWidePaste: false,
      autoPaste: false,
      pushToTalkShortcut: undefined,
    });
  });

  it("leaves global shortcuts off when the settings read fails", async () => {
    tauriMocks.getDictationSettings.mockRejectedValue(new Error("config unreadable"));

    await useDictationStore.getState().loadSettings();

    expect(useDictationStore.getState().settings).toBeNull();
    expect(useDictationStore.getState().settings?.globalShortcutsEnabled ?? false).toBe(
      false,
    );
  });
});

describe("dictationStore — history removal", () => {
  const entry = (id: number, text: string) => ({
    id,
    text,
    mode: "transcribe",
    timestamp: "2026-08-29T10:00:00Z",
    wordCount: 2,
    durationSeconds: 1,
    wpm: 120,
    sentiment: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.deleteDictationEntry.mockResolvedValue(undefined);
    tauriMocks.clearDictationHistory.mockResolvedValue(3);
    tauriMocks.getDictationAnalytics.mockResolvedValue(
      JSON.stringify({ totalEntries: 0, totalWords: 0 }),
    );
    useDictationStore.setState({
      error: null,
      history: [entry(1, "keep me"), entry(2, "delete me")],
    });
  });

  it("drops only the deleted row and refetches analytics", async () => {
    const ok = await useDictationStore.getState().deleteEntry(2);

    expect(ok).toBe(true);
    expect(tauriMocks.deleteDictationEntry).toHaveBeenCalledWith(2);
    expect(useDictationStore.getState().history.map((e) => e.id)).toEqual([1]);
    // Streaks, vocabulary first-seen days and n-gram ranks all depend on the
    // whole corpus, so there is no correct local edit — the payload is refetched.
    expect(tauriMocks.getDictationAnalytics).toHaveBeenCalledTimes(1);
  });

  // The row must NOT vanish from the list when the backend refused, or the
  // user is left believing a transcript is gone while it is still on disk.
  it("keeps the row and surfaces the error when the delete fails", async () => {
    tauriMocks.deleteDictationEntry.mockRejectedValue(new Error("No dictation entry with id 2"));

    const ok = await useDictationStore.getState().deleteEntry(2);

    expect(ok).toBe(false);
    expect(useDictationStore.getState().history.map((e) => e.id)).toEqual([1, 2]);
    expect(useDictationStore.getState().error).toMatch(/No dictation entry/);
    expect(tauriMocks.getDictationAnalytics).not.toHaveBeenCalled();
  });

  it("empties the list and reports how many rows went", async () => {
    const removed = await useDictationStore.getState().clearHistory();

    expect(removed).toBe(3);
    expect(useDictationStore.getState().history).toEqual([]);
    expect(tauriMocks.getDictationAnalytics).toHaveBeenCalledTimes(1);
  });

  it("leaves the list intact when the clear fails", async () => {
    tauriMocks.clearDictationHistory.mockRejectedValue(new Error("database is locked"));

    const removed = await useDictationStore.getState().clearHistory();

    expect(removed).toBeNull();
    expect(useDictationStore.getState().history).toHaveLength(2);
    expect(useDictationStore.getState().error).toMatch(/database is locked/);
  });
});

describe("dictationStore — word goals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the configured goals", async () => {
    tauriMocks.getDictationSettings.mockResolvedValue(
      JSON.stringify({ dailyWordGoal: 800, weeklyWordGoal: 4_000 }),
    );

    await useDictationStore.getState().loadSettings();

    expect(useDictationStore.getState().settings).toMatchObject({
      dailyWordGoal: 800,
      weeklyWordGoal: 4_000,
    });
  });

  // 0 means "no goal" and drops the chart; a config predating the setting has
  // no field at all and must inherit the shipped values, not 0.
  it("keeps an explicit 0 but defaults a missing goal", async () => {
    tauriMocks.getDictationSettings.mockResolvedValue(
      JSON.stringify({ dailyWordGoal: 0 }),
    );

    await useDictationStore.getState().loadSettings();

    expect(useDictationStore.getState().settings).toMatchObject({
      dailyWordGoal: 0,
      weeklyWordGoal: 2_500,
    });
  });

  it("treats a corrupt goal as absent rather than as no goal", async () => {
    tauriMocks.getDictationSettings.mockResolvedValue(
      JSON.stringify({ dailyWordGoal: -5, weeklyWordGoal: "lots" }),
    );

    await useDictationStore.getState().loadSettings();

    expect(useDictationStore.getState().settings).toMatchObject({
      dailyWordGoal: 500,
      weeklyWordGoal: 2_500,
    });
  });
});

/**
 * Whisper models are 75 MB to 3 GB each and the card had no way to remove one.
 * The store action is the seam that keeps the list honest: the model list is
 * re-read from disk on BOTH paths, so a delete that failed cannot leave the UI
 * rendering a row it merely assumed had gone (or, worse, dropping one that is
 * still on disk).
 */
describe("dictationStore — model deletion", () => {
  const onDisk = { ...readyModel };

  beforeEach(() => {
    vi.clearAllMocks();
    useDictationStore.setState({ models: [onDisk], error: null });
  });

  it("removes the file and re-reads the list", async () => {
    tauriMocks.deleteWhisperModel.mockResolvedValue(undefined);
    tauriMocks.listWhisperModels.mockResolvedValue([]);

    const deleted = await useDictationStore.getState().deleteModel("base");

    expect(deleted).toBe(true);
    expect(tauriMocks.deleteWhisperModel).toHaveBeenCalledWith("base");
    expect(useDictationStore.getState().models).toEqual([]);
    expect(useDictationStore.getState().error).toBeNull();
  });

  it("reports the failure and keeps the row when the file will not delete", async () => {
    tauriMocks.deleteWhisperModel.mockRejectedValue(
      "Failed to delete model file: Access is denied. (os error 5)",
    );
    tauriMocks.listWhisperModels.mockResolvedValue([onDisk]);

    const deleted = await useDictationStore.getState().deleteModel("base");

    expect(deleted).toBe(false);
    // The list is still re-read: whatever the disk says wins over the guess.
    expect(tauriMocks.listWhisperModels).toHaveBeenCalled();
    expect(useDictationStore.getState().models).toEqual([onDisk]);
    expect(useDictationStore.getState().error).toMatch(/Access is denied/);
  });

  // The backend rejects any size that is not a shipped model id (its
  // path-traversal guard). That rejection must reach the user, not be
  // swallowed into a silent no-op.
  it("surfaces a rejected model id", async () => {
    tauriMocks.deleteWhisperModel.mockRejectedValue("Unknown model size '../../secrets'");
    tauriMocks.listWhisperModels.mockResolvedValue([onDisk]);

    expect(await useDictationStore.getState().deleteModel("../../secrets")).toBe(false);
    expect(useDictationStore.getState().error).toMatch(/Unknown model size/);
  });
});
