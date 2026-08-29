/**
 * Dictation history timestamps follow Tools → Date & Time.
 *
 * The Date & Time card says it sets "the zone every date and time in
 * PacketBench is displayed in", but the History list formatted its dates with
 * `toLocaleDateString(undefined, …)` — the *browser's* zone, not the
 * configured one. On a machine whose host zone differs from the setting the
 * card was simply wrong, and the Analytics tab's UTC-bucketing note was
 * mis-gated: it decides whether to appear by comparing UTC against the
 * configured zone, while History was rendering in a third zone entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DictationEntry } from "@/types/dictation";
import { useAppStore } from "@/stores/appStore";

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

/** 02:00 UTC on 1 January — still 31 December in any western zone. */
const entries: DictationEntry[] = [
  {
    id: 1,
    text: "an entry recorded just after UTC midnight",
    mode: "transcribe",
    timestamp: "2026-01-01T02:00:00Z",
    wordCount: 7,
    durationSeconds: 3,
    wpm: 120,
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

function showHistory() {
  render(<DictationView />);
  fireEvent.click(screen.getByRole("tab", { name: /History/i }));
}

describe("dictation history timestamps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Well past the 24h relative-time window, so the row renders a date rather
    // than "3h ago" — the date is the part the zone actually changes.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
    useAppStore.setState({ timeZone: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ timeZone: null });
  });

  it("renders the date in the configured zone, not the browser's", () => {
    useAppStore.setState({ timeZone: "America/New_York" });
    showHistory();

    // 2026-01-01T02:00Z is 2025-12-31 21:00 in New York.
    expect(screen.getByTitle(/Dec 31/)).toBeInTheDocument();
    expect(screen.queryByTitle(/Jan 1/)).not.toBeInTheDocument();
  });

  it("moves the same entry to the next day when the zone is UTC", () => {
    useAppStore.setState({ timeZone: "UTC" });
    showHistory();

    expect(screen.getByTitle(/Jan 1/)).toBeInTheDocument();
  });
});
