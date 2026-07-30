/**
 * Tile program (P5-S1): the survivors hoisted out of the retiring AgentsView.
 * Verifies each keybinding fires in its new App-level home with the typing
 * guard intact, and that sweepAutoArchive runs on mount + hourly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const createWorkspace = vi.fn(() => "ws-new");
const setActiveView = vi.fn();
const selectConversation = vi.fn();
const cycleTranscriptViewMode = vi.fn();
const sweepAutoArchive = vi.fn();
let activeView = "workspace";

vi.mock("@/stores/appStore", () => ({
  useAppStore: { getState: () => ({ activeView, setActiveView }) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ projectPath: "/proj" }) },
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ createWorkspace }) },
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

  it("Ctrl+N starts a new session (empty workspace + Workspace surface)", () => {
    renderHook(() => useAgentTabHoists());
    const e = fireKey({ ctrlKey: true, key: "n" });
    expect(createWorkspace).toHaveBeenCalledWith("New Session", [], "/proj");
    expect(setActiveView).toHaveBeenCalledWith("workspace");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+N also starts a new session", () => {
    renderHook(() => useAgentTabHoists());
    fireKey({ metaKey: true, key: "n" });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+N opens the launcher in Agents without creating a workspace", () => {
    activeView = "agents";
    renderHook(() => useAgentTabHoists());

    fireKey({ ctrlKey: true, key: "n" });

    expect(selectConversation).toHaveBeenCalledWith(null);
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(setActiveView).not.toHaveBeenCalled();
  });

  it("Ctrl+N yields to typing when focus is in an input (guard)", () => {
    renderHook(() => useAgentTabHoists());
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireKey({ ctrlKey: true, key: "n" }, input);
    expect(createWorkspace).not.toHaveBeenCalled();
    input.remove();
  });

  it("Ctrl+Shift+N does NOT start a new session (shift excluded)", () => {
    renderHook(() => useAgentTabHoists());
    fireKey({ ctrlKey: true, shiftKey: true, key: "N" });
    expect(createWorkspace).not.toHaveBeenCalled();
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
    expect(createWorkspace).not.toHaveBeenCalled();
  });
});
