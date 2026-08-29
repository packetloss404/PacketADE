/**
 * Two honesty fixes on the dictation settings card.
 *
 * 1. Word goals. The daily/weekly targets the Analytics tab charts against
 *    were `const`s in `analytics.rs` with no control anywhere — a goal the
 *    user cannot set is not a goal.
 * 2. Platform. `deliver_dictation_text` has a native implementation on Windows
 *    only; elsewhere it returns a typed error and delivery falls back to the
 *    webview clipboard. The "paste into other apps" switch therefore cannot
 *    work off Windows and must say so rather than flipping to no effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DictationSettings } from "@/types/dictation";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@/lib/tauri", () => ({
  listAudioDevices: vi.fn().mockResolvedValue([]),
  testAudioDevice: vi.fn(),
}));

const platform = vi.hoisted(() => ({ isWindows: vi.fn(() => true) }));
vi.mock("@/lib/platform", () => platform);

const settings: DictationSettings = {
  modelSize: "base",
  deviceId: null,
  deviceIndex: null,
  customDictionary: [],
  autoPaste: true,
  language: "auto",
  systemWidePaste: false,
  globalShortcutsEnabled: false,
  maxDurationSeconds: 300,
  dailyWordGoal: 500,
  weeklyWordGoal: 2_500,
};

const updateSettings = vi.fn();
const state = {
  settings,
  models: [],
  modelProgress: {},
  loadSettings: vi.fn(),
  loadModels: vi.fn(),
  updateSettings,
  downloadModel: vi.fn(),
};
vi.mock("@/stores/dictationStore", () => ({
  useDictationStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settingsFocus: null, clearSettingsFocus: vi.fn() }),
}));

import { DictationSettingsCard } from "@/components/views/tools/DictationSettingsCard";

describe("DictationSettingsCard — word goals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.isWindows.mockReturnValue(true);
    state.settings = { ...settings };
  });

  it("shows the stored goals and writes an edit back", () => {
    render(<DictationSettingsCard />);

    const daily = screen.getByLabelText("Daily word goal");
    expect(daily).toHaveValue(500);
    expect(screen.getByLabelText("Weekly word goal")).toHaveValue(2_500);

    fireEvent.change(daily, { target: { value: "800" } });

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ dailyWordGoal: 800 }),
    );
  });

  // Clearing the field mid-edit produces "", which `Number("")` turns into 0 —
  // and 0 is the deliberate "no goal" value. Writing it on a blank field would
  // silently switch the chart off while the user was typing.
  it("does not write a goal of 0 for a field cleared mid-edit", () => {
    render(<DictationSettingsCard />);

    fireEvent.change(screen.getByLabelText("Daily word goal"), { target: { value: "" } });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("says that 0 turns a goal off", () => {
    render(<DictationSettingsCard />);
    expect(screen.getByText(/Set either to 0 to drop/i)).toBeInTheDocument();
  });
});

describe("DictationSettingsCard — platform support for native paste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.settings = { ...settings };
  });

  afterEach(() => {
    platform.isWindows.mockReturnValue(true);
  });

  it("offers the toggle on Windows", () => {
    platform.isWindows.mockReturnValue(true);
    render(<DictationSettingsCard />);

    expect(screen.getByLabelText("Paste into other apps")).toBeEnabled();
  });

  it("disables it elsewhere and says what happens instead", () => {
    platform.isWindows.mockReturnValue(false);
    render(<DictationSettingsCard />);

    expect(screen.getByLabelText("Paste into other apps")).toBeDisabled();
    expect(screen.getByText(/Windows only/i)).toBeInTheDocument();
    expect(screen.getByText(/copied to the clipboard instead/i)).toBeInTheDocument();
  });

  // A stored `systemWidePaste: true` carried over from a Windows machine must
  // not render as an armed switch on a platform that cannot honour it.
  it("does not show a stored opt-in as active off Windows", () => {
    platform.isWindows.mockReturnValue(false);
    state.settings = { ...settings, systemWidePaste: true };
    render(<DictationSettingsCard />);

    expect(screen.getByLabelText("Paste into other apps")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
