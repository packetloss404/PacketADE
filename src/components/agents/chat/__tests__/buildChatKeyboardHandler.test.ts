import { describe, it, expect, vi } from "vitest";
import {
  buildChatKeyboardHandler,
  type MentionState,
} from "../buildChatKeyboardHandler";

type Handler = ReturnType<typeof buildChatKeyboardHandler>;
type KeyEvent = Parameters<Handler>[0];

function makeEvent(
  key: string,
  opts: Partial<{
    code: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) {
  const preventDefault = vi.fn();
  const e = {
    key,
    code: opts.code ?? "",
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    preventDefault,
  } as unknown as KeyEvent;
  return { e, preventDefault };
}

function makeDeps(overrides: Partial<Parameters<typeof buildChatKeyboardHandler>[0]> = {}) {
  const deps = {
    textareaRef: { current: null },
    input: "hello world",
    setInput: vi.fn(),
    messages: [],
    mentionState: { kind: "none" } as MentionState,
    setMentionState: vi.fn(),
    historyIndex: -1,
    setHistoryIndex: vi.fn(),
    historySourceRef: { current: "user" as const },
    popoverItemCount: 0,
    allCustomSlashCommands: [],
    userSkills: [],
    cycleMode: vi.fn(),
    runSlashCommand: vi.fn(),
    handleSend: vi.fn(),
    ...overrides,
  };
  return deps;
}

describe("buildChatKeyboardHandler", () => {
  it("Enter sends", () => {
    const deps = makeDeps();
    const handler = buildChatKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Enter");
    handler(e);
    expect(deps.handleSend).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Ctrl+Enter sends", () => {
    const deps = makeDeps();
    const handler = buildChatKeyboardHandler(deps);
    const { e } = makeEvent("Enter", { ctrlKey: true });
    handler(e);
    expect(deps.handleSend).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter does not send (newline)", () => {
    const deps = makeDeps();
    const handler = buildChatKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Enter", { shiftKey: true });
    handler(e);
    expect(deps.handleSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("bare Tab does NOT send and keeps native focus navigation", () => {
    const deps = makeDeps({ input: "some draft text" });
    const handler = buildChatKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Tab");
    handler(e);
    expect(deps.handleSend).not.toHaveBeenCalled();
    // preventDefault must not fire so Tab falls through to focus navigation.
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Shift+Tab cycles the mode chip", () => {
    const deps = makeDeps();
    const handler = buildChatKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Tab", { shiftKey: true });
    handler(e);
    expect(deps.cycleMode).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(deps.handleSend).not.toHaveBeenCalled();
  });

  it("Alt+. / Alt+, no longer nudge the model", () => {
    const deps = makeDeps();
    const handler = buildChatKeyboardHandler(deps);
    for (const code of ["Period", "Comma"]) {
      const { e, preventDefault } = makeEvent("≥", { code, altKey: true });
      handler(e);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(deps.handleSend).not.toHaveBeenCalled();
  });

  it("Ctrl+S no longer stashes the draft", () => {
    const deps = makeDeps({ input: "a draft worth keeping" });
    const handler = buildChatKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("s", { ctrlKey: true });
    handler(e);
    expect(deps.setInput).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("swallows Enter and Tab while the slash popover is open", () => {
    const deps = makeDeps({
      mentionState: {
        kind: "slash",
        query: "zzz-no-match",
        triggerIndex: 0,
        highlightedIndex: 0,
      },
    });
    const handler = buildChatKeyboardHandler(deps);
    for (const key of ["Enter", "Tab"]) {
      const { e, preventDefault } = makeEvent(key);
      handler(e);
      expect(preventDefault).toHaveBeenCalled();
    }
    expect(deps.handleSend).not.toHaveBeenCalled();
  });
});
