import { beforeEach, describe, expect, it, vi } from "vitest";

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
  listWhisperModels: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/lib/tauri", () => tauriMocks);

import { useDictationStore } from "../dictationStore";

const readyModel = {
  size: "base",
  downloaded: true,
  installed: true,
  fileSizeMb: 142,
  path: "C:\\models\\ggml-base.bin",
};

describe("dictationStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.getDictationSettings.mockResolvedValue(
      JSON.stringify({
        modelSize: "base",
        deviceIndex: 2,
        customDictionary: [],
        autoPaste: true,
      }),
    );
    tauriMocks.listWhisperModels.mockResolvedValue([readyModel]);
    tauriMocks.startRecordingCmd.mockResolvedValue(undefined);
    tauriMocks.stopRecordingCmd.mockResolvedValue("hello");
    tauriMocks.cancelRecordingCmd.mockResolvedValue(undefined);
    tauriMocks.getDictationHistory.mockResolvedValue("[]");
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
      status: "idle",
      error: null,
      deliveryNotice: null,
      settings: null,
      models: [],
      modelProgress: {},
      history: [],
      analytics: null,
    });
  });

  it("migrates missing settings fields and uses the saved microphone", async () => {
    await useDictationStore.getState().startRecording();

    expect(useDictationStore.getState().settings).toMatchObject({
      language: "auto",
      systemWidePaste: false,
    });
    expect(tauriMocks.startRecordingCmd).toHaveBeenCalledWith(2);
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
});
