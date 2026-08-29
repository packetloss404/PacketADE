/**
 * Deleting a downloaded Whisper model.
 *
 * `delete_whisper_model` existed and was hardened against path traversal, but
 * nothing called it: the card could download 75 MB to 3 GB per model and
 * offered no way to get the disk back. These tests pin the four things that
 * make the affordance safe rather than merely present.
 *
 *   1. The row quotes the model's REAL size on disk, not the shipped estimate.
 *      The reclaim figure is the entire justification for the button.
 *   2. Nothing is deleted from the row click alone — the shared
 *      `ConfirmDeleteModal` stands between, per the `scripts/confirm-idiom`
 *      fence (native `window.confirm` is banned).
 *   3. Deleting the model dictation is set to use is allowed but never silent:
 *      the confirm names what transcription falls back to, and the fallback is
 *      actually written to settings afterwards.
 *   4. A failed delete leaves the selection alone and the row on screen — the
 *      store re-reads the list from disk on both paths, so the UI can never
 *      show a model it only assumed was gone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DictationSettings, WhisperModel } from "@/types/dictation";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@/lib/tauri", () => ({
  listAudioDevices: vi.fn().mockResolvedValue([]),
  testAudioDevice: vi.fn(),
}));
vi.mock("@/lib/platform", () => ({ isWindows: vi.fn(() => true) }));

const baseSettings: DictationSettings = {
  modelSize: "base",
  deviceId: null,
  deviceIndex: null,
  customDictionary: [],
  autoPaste: false,
  language: "auto",
  systemWidePaste: false,
  globalShortcutsEnabled: false,
  maxDurationSeconds: 300,
  dailyWordGoal: 500,
  weeklyWordGoal: 2_500,
};

function model(over: Partial<WhisperModel> & { size: string }): WhisperModel {
  return {
    downloaded: true,
    installed: true,
    fileSizeMb: 142,
    diskBytes: 147_964_211,
    path: `C:/models/ggml-${over.size}.bin`,
    ...over,
  };
}

const updateSettings = vi.fn();
const deleteModel = vi.fn();
const state = {
  settings: { ...baseSettings },
  models: [] as WhisperModel[],
  modelProgress: {} as Record<string, number>,
  error: null as string | null,
  loadSettings: vi.fn(),
  loadModels: vi.fn(),
  updateSettings,
  downloadModel: vi.fn(),
  deleteModel,
};
vi.mock("@/stores/dictationStore", () => ({
  useDictationStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setActiveView: vi.fn() }),
}));

import { DictationSettingsCard } from "@/components/views/tools/DictationSettingsCard";
import { formatDiskSize, modelSizeLabel } from "@/lib/whisperModels";

const deleteButton = (size: string) =>
  screen.getByLabelText(`Delete the ${size} Whisper model from disk`);

describe("Whisper model size reporting", () => {
  it("scales bytes into a unit the row can hold", () => {
    expect(formatDiskSize(147_964_211)).toBe("141 MB");
    // 3 GB model: MB would read "3095 MB" and overflow an 11px row.
    expect(formatDiskSize(3_246_000_000)).toBe("3.0 GB");
    expect(formatDiskSize(400_000)).toBe("391 KB");
    // A metadata read that came back nonsense must not print "NaN MB".
    expect(formatDiskSize(Number.NaN)).toBe("unknown size");
  });

  // The spec figure is rounded (the "large-v3" row advertises a flat 3000 MB
  // against a ~3.1 GB file), so quoting it as the reclaim would be a number the
  // disk never honours.
  it("quotes the on-disk size for installed models and the estimate otherwise", () => {
    expect(modelSizeLabel(model({ size: "large-v3", diskBytes: 3_246_000_000 }))).toBe("3.0 GB");
    expect(
      modelSizeLabel(
        model({ size: "small", installed: false, downloaded: false, diskBytes: null, fileSizeMb: 466 }),
      ),
    ).toBe("466 MB");
  });
});

describe("DictationSettingsCard — model deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.settings = { ...baseSettings };
    state.models = [];
    state.modelProgress = {};
    state.error = null;
    deleteModel.mockResolvedValue(true);
  });

  it("shows the on-disk size and offers delete only for models that are on disk", () => {
    state.models = [
      model({ size: "base", diskBytes: 147_964_211 }),
      model({ size: "small", installed: false, downloaded: false, diskBytes: null, fileSizeMb: 466 }),
    ];

    render(<DictationSettingsCard />);

    expect(screen.getByText("141 MB")).toBeInTheDocument();
    expect(screen.getByText("466 MB")).toBeInTheDocument();
    expect(deleteButton("base")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Delete the small Whisper model from disk"),
    ).not.toBeInTheDocument();
  });

  // An unverified leftover occupies exactly as many gigabytes as a good one,
  // and is the case a user most wants to clear.
  it("offers delete for an installed-but-unverified file", () => {
    state.models = [model({ size: "medium", downloaded: false, diskBytes: 1_500_000_000 })];

    render(<DictationSettingsCard />);

    expect(deleteButton("medium")).toBeInTheDocument();
  });

  // Racing the writer would delete a file mid-stream and leave the download
  // reporting progress against nothing.
  it("withdraws delete while that model is downloading", () => {
    state.models = [model({ size: "base" })];
    state.modelProgress = { base: 42 };

    render(<DictationSettingsCard />);

    expect(
      screen.queryByLabelText("Delete the base Whisper model from disk"),
    ).not.toBeInTheDocument();
  });

  it("deletes nothing until the shared confirm is accepted", async () => {
    state.models = [model({ size: "small", fileSizeMb: 466, diskBytes: 489_000_000 })];
    state.settings = { ...baseSettings, modelSize: "base" };

    render(<DictationSettingsCard />);
    fireEvent.click(deleteButton("small"));

    expect(screen.getByText("Delete Whisper model?")).toBeInTheDocument();
    // The reclaim is named in the prompt, not just the tooltip.
    expect(screen.getByText(/freeing 466 MB/)).toBeInTheDocument();
    expect(deleteModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Cancel"));
    expect(deleteModel).not.toHaveBeenCalled();

    fireEvent.click(deleteButton("small"));
    fireEvent.click(screen.getByText("Delete model"));

    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith("small"));
  });

  it("warns that the selected model is in use and names the model it switches to", async () => {
    state.models = [model({ size: "base" }), model({ size: "small", fileSizeMb: 466 })];
    state.settings = { ...baseSettings, modelSize: "base" };

    render(<DictationSettingsCard />);
    fireEvent.click(deleteButton("base"));

    expect(screen.getByText("This is the model dictation uses")).toBeInTheDocument();
    expect(
      screen.getByText(/switches dictation to the small model/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Delete model"));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ modelSize: "small" }),
      ),
    );
  });

  it("says transcription stops when the selected model is the last one ready", () => {
    state.models = [
      model({ size: "base" }),
      // Present on disk but unverified, so it cannot serve as a fallback.
      model({ size: "small", downloaded: false, fileSizeMb: 466 }),
    ];
    state.settings = { ...baseSettings, modelSize: "base" };

    render(<DictationSettingsCard />);
    fireEvent.click(deleteButton("base"));

    expect(
      screen.getByText(/no other model is ready.*cannot transcribe until you download/s),
    ).toBeInTheDocument();
  });

  // Deleting the last ready model empties the highlight and leaves no green
  // border anywhere — which is not, on its own, an explanation of why
  // recording stopped working.
  it("says out loud when no model is ready to transcribe", () => {
    state.models = [model({ size: "base", downloaded: false })];

    render(<DictationSettingsCard />);

    expect(screen.getByText(/No model is ready, so dictation cannot transcribe/)).toBeInTheDocument();
  });

  it("stays quiet while at least one model is ready", () => {
    state.models = [model({ size: "base" })];

    render(<DictationSettingsCard />);

    expect(screen.queryByText(/No model is ready/)).not.toBeInTheDocument();
  });

  it("deleting a model that is not selected leaves the selection alone", async () => {
    state.models = [model({ size: "base" }), model({ size: "small", fileSizeMb: 466 })];
    state.settings = { ...baseSettings, modelSize: "base" };

    render(<DictationSettingsCard />);
    fireEvent.click(deleteButton("small"));

    expect(screen.queryByText("This is the model dictation uses")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Delete model"));

    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith("small"));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  // The row is rendered from the store's model list, which `deleteModel`
  // re-reads from disk whether or not the removal worked. A failed delete
  // therefore keeps the row — and must not re-point the setting at a model the
  // user still has.
  it("keeps the selection and the row when the delete fails", async () => {
    state.models = [model({ size: "base" }), model({ size: "small", fileSizeMb: 466 })];
    state.settings = { ...baseSettings, modelSize: "base" };
    deleteModel.mockResolvedValue(false);

    render(<DictationSettingsCard />);
    fireEvent.click(deleteButton("base"));
    fireEvent.click(screen.getByText("Delete model"));

    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith("base"));
    expect(updateSettings).not.toHaveBeenCalled();
    expect(deleteButton("base")).toBeInTheDocument();
  });

  it("surfaces the store's error text after a failed delete", () => {
    state.models = [model({ size: "base" })];
    state.error = "Failed to delete model file: Access is denied. (os error 5)";

    render(<DictationSettingsCard />);

    expect(screen.getByRole("alert")).toHaveTextContent("Access is denied");
  });
});
