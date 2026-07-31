/**
 * UX-08: the app-shell keydown listener must yield Ctrl+K (readline kill-line)
 * to terminals and text fields, while still opening the palette everywhere
 * else and keeping modal-dismiss Escape intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const setCommandPaletteOpen = vi.fn();
const setActiveView = vi.fn();
const cancelRecording = vi.fn();
let commandPaletteOpen = false;
let dictation = { isStarting: false, isRecording: false, cancelRecording };

vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => ({ commandPaletteOpen, setCommandPaletteOpen, setActiveView }),
  },
}));
vi.mock("@/stores/dictationStore", () => ({
  useDictationStore: { getState: () => dictation },
}));

import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function fireKey(init: KeyboardEventInit, target?: EventTarget) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(e);
  return e;
}

describe("useGlobalShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandPaletteOpen = false;
    dictation = { isStarting: false, isRecording: false, cancelRecording };
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("Ctrl+K", () => {
    it("opens the palette from ordinary chrome", () => {
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<button id="b"></button>`);
      const e = fireKey({ ctrlKey: true, key: "k" }, host.querySelector("#b")!);
      expect(setCommandPaletteOpen).toHaveBeenCalledWith(true);
      expect(e.defaultPrevented).toBe(true);
    });

    it("does NOT open the palette inside an xterm terminal", () => {
      renderHook(() => useGlobalShortcuts());
      const host = mount(
        `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`,
      );
      const e = fireKey({ ctrlKey: true, key: "k" }, host.querySelector("textarea")!);
      expect(setCommandPaletteOpen).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    });

    it("does NOT open the palette inside an input or textarea", () => {
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<div><input id="i" /><textarea id="t"></textarea></div>`);
      fireKey({ ctrlKey: true, key: "k" }, host.querySelector("#i")!);
      fireKey({ ctrlKey: true, key: "k" }, host.querySelector("#t")!);
      expect(setCommandPaletteOpen).not.toHaveBeenCalled();
    });

    it("does NOT open the palette inside a contenteditable", () => {
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<div contenteditable="true"><span id="s">x</span></div>`);
      fireKey({ ctrlKey: true, key: "k" }, host.querySelector("#s")!);
      expect(setCommandPaletteOpen).not.toHaveBeenCalled();
    });

    it("still closes the palette when it is already open (its input holds focus)", () => {
      commandPaletteOpen = true;
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<input id="i" />`);
      fireKey({ ctrlKey: true, key: "k" }, host.querySelector("#i")!);
      expect(setCommandPaletteOpen).toHaveBeenCalledWith(false);
    });

    it("ignores Ctrl+Shift+K so it can't shadow other chords", () => {
      renderHook(() => useGlobalShortcuts());
      fireKey({ ctrlKey: true, shiftKey: true, key: "K", code: "KeyK" });
      expect(setCommandPaletteOpen).not.toHaveBeenCalled();
    });
  });

  describe("Escape", () => {
    it("closes an open palette regardless of focus (modal dismiss)", () => {
      commandPaletteOpen = true;
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<input id="i" />`);
      const e = fireKey({ key: "Escape" }, host.querySelector("#i")!);
      expect(setCommandPaletteOpen).toHaveBeenCalledWith(false);
      expect(e.defaultPrevented).toBe(true);
    });

    it("cancels an active dictation recording outside a terminal", () => {
      dictation = { isStarting: false, isRecording: true, cancelRecording };
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<input id="i" />`);
      fireKey({ key: "Escape" }, host.querySelector("#i")!);
      expect(cancelRecording).toHaveBeenCalled();
    });

    it("leaves Escape to the CLI when it comes from a terminal", () => {
      dictation = { isStarting: false, isRecording: true, cancelRecording };
      renderHook(() => useGlobalShortcuts());
      const host = mount(
        `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`,
      );
      const e = fireKey({ key: "Escape" }, host.querySelector("textarea")!);
      expect(cancelRecording).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    });
  });

  describe("Ctrl+Shift view chords", () => {
    it("switches view from ordinary chrome", () => {
      renderHook(() => useGlobalShortcuts());
      fireKey({ ctrlKey: true, shiftKey: true, key: "W", code: "KeyW" });
      expect(setActiveView).toHaveBeenCalledWith("workspace");
    });

    it("still works while typing in a composer", () => {
      renderHook(() => useGlobalShortcuts());
      const host = mount(`<textarea id="t"></textarea>`);
      fireKey({ ctrlKey: true, shiftKey: true, key: "W", code: "KeyW" }, host.querySelector("#t")!);
      expect(setActiveView).toHaveBeenCalledWith("workspace");
    });

    it("yields to a terminal", () => {
      renderHook(() => useGlobalShortcuts());
      const host = mount(
        `<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`,
      );
      fireKey(
        { ctrlKey: true, shiftKey: true, key: "W", code: "KeyW" },
        host.querySelector("textarea")!,
      );
      expect(setActiveView).not.toHaveBeenCalled();
    });
  });

  it("yields to an inner layer that already handled the keypress", () => {
    renderHook(() => useGlobalShortcuts());
    const host = mount(`<div id="outer"><button id="b"></button></div>`);
    // An inner handler consumes the chord first (xterm, dropdown, palette list).
    host.addEventListener("keydown", (e) => e.preventDefault());
    fireKey({ ctrlKey: true, key: "k" }, host.querySelector("#b")!);
    expect(setCommandPaletteOpen).not.toHaveBeenCalled();
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useGlobalShortcuts());
    unmount();
    fireKey({ ctrlKey: true, key: "k" });
    expect(setCommandPaletteOpen).not.toHaveBeenCalled();
  });
});
