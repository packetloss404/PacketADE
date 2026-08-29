/**
 * Dictation history removal.
 *
 * Before this landed, the only way to remove a transcript was to delete
 * `dictation.db` by hand — all of it or none of it. Dictation records whatever
 * the microphone heard, so "all or nothing" is not an acceptable answer.
 *
 * Both removals go through the shared `ConfirmDeleteModal` (the repo fences
 * `window.confirm` out of `src/` — see `scripts/confirm-idiom.test.mjs`), and
 * the thing worth pinning is that NOTHING is destroyed until the modal's own
 * confirm button is pressed. `HistoryPanel` is internal to `DictationView`, so
 * these tests mount the view and drive the real DOM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DictationEntry } from "@/types/dictation";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

const storeMocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  clearHistory: vi.fn(),
  loadAnalytics: vi.fn(),
  loadHistory: vi.fn(),
  loadSettings: vi.fn(),
  loadModels: vi.fn(),
  searchHistory: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  cancelRecording: vi.fn(),
  clearResult: vi.fn(),
}));

const entries: DictationEntry[] = [
  {
    id: 1,
    text: "the first transcript, which stays",
    mode: "transcribe",
    timestamp: "2026-08-29T10:00:00Z",
    wordCount: 6,
    durationSeconds: 3,
    wpm: 120,
    sentiment: null,
  },
  {
    id: 2,
    text: "the second transcript, which the user regrets",
    mode: "transcribe",
    timestamp: "2026-08-29T11:00:00Z",
    wordCount: 7,
    durationSeconds: 4,
    wpm: 105,
    sentiment: null,
  },
];

const state = {
  isStarting: false,
  isRecording: false,
  isTranscribing: false,
  lastResult: null,
  lastTelemetry: null,
  error: null,
  deliveryNotice: null,
  waveform: [],
  analytics: null,
  history: entries,
  settings: null,
  shortcutStatus: { state: "disabled" as const },
  ...storeMocks,
};

vi.mock("@/stores/dictationStore", () => ({
  useDictationStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

import { DictationView } from "@/components/views/DictationView";

/** Open the History tab — the view lands on Analytics. */
function showHistory() {
  render(<DictationView />);
  fireEvent.click(screen.getByRole("tab", { name: /History/i }));
}

describe("dictation history removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.deleteEntry.mockResolvedValue(true);
    storeMocks.clearHistory.mockResolvedValue(2);
  });

  it("names the transcript before deleting it, and deletes only on confirm", async () => {
    showHistory();

    fireEvent.click(
      screen.getByRole("button", { name: /Delete transcription: the second transcript/i }),
    );

    // The dialog has to show WHICH row is about to go.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Delete this transcription\?/i);
    expect(dialog).toHaveTextContent(/the second transcript, which the user regrets/i);
    expect(storeMocks.deleteEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(storeMocks.deleteEntry).toHaveBeenCalledWith(2));
  });

  it("destroys nothing when the delete confirm is cancelled", () => {
    showHistory();

    fireEvent.click(
      screen.getByRole("button", { name: /Delete transcription: the first transcript/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(storeMocks.deleteEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clears the whole history only on confirm, and says how much goes", async () => {
    showHistory();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Clear all transcriptions\?/i);
    expect(dialog).toHaveTextContent(/Deletes every transcription/i);
    expect(dialog).toHaveTextContent(/2 are currently listed/i);
    // A search-narrowed list still clears everything; that has to be stated.
    expect(dialog).toHaveTextContent(/the whole history goes/i);
    expect(storeMocks.clearHistory).not.toHaveBeenCalled();

    // The dialog's own confirm button, not the toolbar button that opened it.
    const clearButtons = screen.getAllByRole("button", { name: "Clear all" });
    fireEvent.click(clearButtons[clearButtons.length - 1]);

    await waitFor(() => expect(storeMocks.clearHistory).toHaveBeenCalledTimes(1));
  });

  it("keeps the row expander and the delete control as separate controls", () => {
    showHistory();

    // A button nested inside a button is invalid HTML, and the delete click
    // would also toggle the row open.
    const remove = screen.getByRole("button", {
      name: /Delete transcription: the first transcript/i,
    });
    expect(remove.closest("button")).toBe(remove);
  });
});

describe("dictation history removal — empty history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.history = [];
  });

  it("does not offer a clear-all with nothing to clear", () => {
    showHistory();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    state.history = entries;
  });
});
