import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPersistedState: vi.fn(),
  saveSettingsSlice: vi.fn(),
}));

vi.mock("@/lib/tauri", () => mocks);

import {
  DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
  useOrchestrationSettingsStore,
} from "@/stores/orchestrationSettingsStore";
import { DEFAULT_AUTONOMY_POLICY } from "@/lib/autonomyPolicy";

function persistedSettings() {
  return {
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: "D:\\project",
      autoCommitTrailerEnabled: true,
      autoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
      autonomyDefaultMode: "assisted" as const,
      autonomyDefaultPolicy: DEFAULT_AUTONOMY_POLICY,
    },
  };
}

describe("orchestrationSettingsStore authoritative persistence", () => {
  beforeEach(() => {
    mocks.loadPersistedState.mockReset();
    mocks.saveSettingsSlice.mockReset();
    mocks.loadPersistedState.mockResolvedValue(persistedSettings());
    mocks.saveSettingsSlice.mockResolvedValue(undefined);
    useOrchestrationSettingsStore.setState({
      autoCommitTrailerEnabled: true,
      autoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
      confirmedAutoCommitTrailerEnabled: true,
      confirmedAutoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
      autonomyDefaultMode: "assisted",
      autonomyDefaultPolicy: DEFAULT_AUTONOMY_POLICY,
      saveStatus: "idle",
      saveError: null,
      lastSaveKind: null,
      settingsRevision: 0,
      savedRevision: 0,
    });
  });

  it("does not publish a new autonomy default until the backend accepts it", async () => {
    let finishSave!: () => void;
    mocks.saveSettingsSlice.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishSave = resolve)),
    );

    const save = useOrchestrationSettingsStore.getState().setAutonomyDefault("yolo", {
      ...DEFAULT_AUTONOMY_POLICY,
      allowedRoots: ["D:\\project"],
      allowedTargets: ["local"],
    });

    await vi.waitFor(() => expect(mocks.saveSettingsSlice).toHaveBeenCalledTimes(1));
    expect(useOrchestrationSettingsStore.getState()).toMatchObject({
      autonomyDefaultMode: "assisted",
      saveStatus: "saving",
    });

    finishSave();
    await save;
    expect(useOrchestrationSettingsStore.getState()).toMatchObject({
      autonomyDefaultMode: "yolo",
      saveStatus: "saved",
      settingsRevision: 1,
      savedRevision: 1,
    });
  });

  it("surfaces a backend failure and keeps the prior autonomy default", async () => {
    mocks.saveSettingsSlice.mockRejectedValueOnce(new Error("disk locked"));

    await expect(
      useOrchestrationSettingsStore.getState().setAutonomyDefault("yolo", {
        ...DEFAULT_AUTONOMY_POLICY,
        allowedRoots: ["D:\\project"],
        allowedTargets: ["local"],
      }),
    ).rejects.toThrow("disk locked");

    expect(useOrchestrationSettingsStore.getState()).toMatchObject({
      autonomyDefaultMode: "assisted",
      saveStatus: "error",
      saveError: "disk locked",
      savedRevision: 0,
    });
  });

  it("serializes rapid settings patches and keeps the newest completion authoritative", async () => {
    let finishFirst!: () => void;
    mocks.saveSettingsSlice.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );

    const first = useOrchestrationSettingsStore.getState().setAutoCommitTrailerFormat("first");
    const second = useOrchestrationSettingsStore.getState().setAutoCommitTrailerFormat("second");

    await vi.waitFor(() => expect(mocks.saveSettingsSlice).toHaveBeenCalledTimes(1));
    expect(useOrchestrationSettingsStore.getState().autoCommitTrailerFormat).toBe("second");
    finishFirst();
    await first;
    await second;

    expect(mocks.saveSettingsSlice).toHaveBeenCalledTimes(2);
    expect(mocks.saveSettingsSlice.mock.calls[1][0]).toMatchObject({
      autoCommitTrailerFormat: "second",
    });
    expect(useOrchestrationSettingsStore.getState()).toMatchObject({
      autoCommitTrailerFormat: "second",
      saveStatus: "saved",
      settingsRevision: 2,
      savedRevision: 2,
    });
  });

  it("restores the prior trailer value and reports the failure beside that settings group", async () => {
    mocks.saveSettingsSlice.mockRejectedValueOnce(new Error("settings file locked"));

    await expect(
      useOrchestrationSettingsStore.getState().setAutoCommitTrailerFormat("custom"),
    ).rejects.toThrow("settings file locked");

    expect(useOrchestrationSettingsStore.getState()).toMatchObject({
      autoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
      saveStatus: "error",
      saveError: "settings file locked",
      lastSaveKind: "trailer",
    });
  });

  it("rolls a failed rapid edit series back to the last confirmed backend value", async () => {
    mocks.saveSettingsSlice.mockRejectedValueOnce(new Error("first failed"));
    mocks.saveSettingsSlice.mockRejectedValueOnce(new Error("second failed"));

    const first = useOrchestrationSettingsStore.getState().setAutoCommitTrailerFormat("first");
    const second = useOrchestrationSettingsStore.getState().setAutoCommitTrailerFormat("second");
    await Promise.allSettled([first, second]);

    expect(useOrchestrationSettingsStore.getState()).toMatchObject({
      autoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
      confirmedAutoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
      saveStatus: "error",
      saveError: "second failed",
    });
  });
});
