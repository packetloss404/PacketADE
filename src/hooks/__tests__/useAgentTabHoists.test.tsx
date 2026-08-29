/**
 * Tile program (P5-S1): the survivors hoisted out of the retiring AgentsView.
 * Verifies each keybinding fires in its new App-level home with the typing
 * guard intact, and that sweepAutoArchive runs on mount + hourly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const createInstantWorkspace = vi.fn(async () => "ws-new");
const setActiveView = vi.fn();
const selectConversation = vi.fn();
const cycleTranscriptViewMode = vi.fn();
const sweepAutoArchive = vi.fn();
let activeView = "workspace";

vi.mock("@/stores/appStore", () => ({
  useAppStore: { getState: () => ({ activeView, setActiveView }) },
}));
// Ctrl+N delegates to the ONE instant-creation front door, which owns the
// naming + empty-path rules (covered by workspaceCreation.test.ts).
vi.mock("@/lib/workspaceCreation", () => ({
  createInstantWorkspace: () => createInstantWorkspace(),
}));
vi.mock("@/stores/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ cycleTranscriptViewMode }) },
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: { getState: () => ({ selectConversation }) },
}));
vi.mock("@/stores/agentConversationPersistence", () => ({
  sweepAutoArchive: (...args: unknown[]) => sweepAutoArchive(...args),
}));

import { useAgentTabHoists } from "@/hooks/useAgentTabHoists";
import { COMPOSER_HELP_TEXT } from "@/components/agents/composer/utils";

function fireKey(init: KeyboardEventInit, target?: HTMLElement) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(e);
  return e;
}

describe("useAgentTabHoists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    activeView = "workspace";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Ctrl+N creates a workspace via the shared instant-creation front door", () => {
    renderHook(() => useAgentTabHoists());
    const e = fireKey({ ctrlKey: true, key: "n" });
    expect(createInstantWorkspace).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+N also creates a workspace", () => {
    renderHook(() => useAgentTabHoists());
    fireKey({ metaKey: true, key: "n" });
    expect(createInstantWorkspace).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+N opens the launcher in Agents without creating a workspace", () => {
    activeView = "agents";
    renderHook(() => useAgentTabHoists());

    fireKey({ ctrlKey: true, key: "n" });

    expect(selectConversation).toHaveBeenCalledWith(null);
    expect(createInstantWorkspace).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });

  it("Ctrl+N yields to typing when focus is in an input (guard)", () => {
    renderHook(() => useAgentTabHoists());
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireKey({ ctrlKey: true, key: "n" }, input);
    expect(createInstantWorkspace).not.toHaveBeenCalled();
    input.remove();
  });

  /**
   * FAULT: `COMPOSER_HELP_TEXT` advertised "Ctrl+N for new agent" in the hint
   * printed directly beneath the launch composer's textarea — where the guard
   * above eats the chord, and where firing it would be a no-op anyway (the
   * launch composer already IS `selectConversation(null)`). This pins the two
   * facts together so the hint cannot drift back in while the guard stands.
   */
  it("does not advertise Ctrl+N in the composer hint, where the guard eats it", () => {
    renderHook(() => useAgentTabHoists());
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    fireKey({ ctrlKey: true, key: "n" }, textarea);
    expect(createInstantWorkspace).not.toHaveBeenCalled();
    expect(selectConversation).not.toHaveBeenCalled();
    textarea.remove();

    expect(COMPOSER_HELP_TEXT).not.toMatch(/ctrl\+n/i);
    // The hints that ARE live from inside the composer must survive.
    expect(COMPOSER_HELP_TEXT).toContain("Enter to send");
    expect(COMPOSER_HELP_TEXT).toContain("Shift+Enter");
    expect(COMPOSER_HELP_TEXT).toContain("@ to mention a file");
  });

  it("Ctrl+Shift+N does NOT start a new session (shift excluded)", () => {
    renderHook(() => useAgentTabHoists());
    fireKey({ ctrlKey: true, shiftKey: true, key: "N" });
    expect(createInstantWorkspace).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+O cycles the transcript view mode", () => {
    renderHook(() => useAgentTabHoists());
    const e = fireKey({ ctrlKey: true, shiftKey: true, key: "O" });
    expect(cycleTranscriptViewMode).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+V does NOT cycle the view mode (that chord is push-to-talk)", () => {
    renderHook(() => useAgentTabHoists());
    fireKey({ ctrlKey: true, shiftKey: true, key: "V" });
    expect(cycleTranscriptViewMode).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+O yields to typing when focus is in a textarea (guard)", () => {
    renderHook(() => useAgentTabHoists());
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    fireKey({ ctrlKey: true, shiftKey: true, key: "O" }, ta);
    expect(cycleTranscriptViewMode).not.toHaveBeenCalled();
    ta.remove();
  });

  it("sweeps auto-archive on mount and then hourly", () => {
    renderHook(() => useAgentTabHoists());
    expect(sweepAutoArchive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sweepAutoArchive).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sweepAutoArchive).toHaveBeenCalledTimes(3);
  });

  it("stops sweeping and unbinds after unmount", () => {
    const { unmount } = renderHook(() => useAgentTabHoists());
    unmount();
    sweepAutoArchive.mockClear();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(sweepAutoArchive).not.toHaveBeenCalled();
    fireKey({ ctrlKey: true, key: "n" });
    expect(createInstantWorkspace).not.toHaveBeenCalled();
  });
});
