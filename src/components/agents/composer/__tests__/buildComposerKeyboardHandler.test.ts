import { describe, it, expect, vi } from "vitest";
import { buildComposerKeyboardHandler } from "../buildComposerKeyboardHandler";
import type { SlashItem } from "../slashCommandSource";

type Handler = ReturnType<typeof buildComposerKeyboardHandler>;
type KeyEvent = Parameters<Handler>[0];
type Deps = Parameters<typeof buildComposerKeyboardHandler>[0];

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

function makeMatcher(
  state: Partial<Deps["mention"]["state"]> = {},
): Deps["mention"] {
  return {
    state: {
      active: false,
      query: "",
      prefixIndex: -1,
      highlightedIndex: 0,
      ...state,
    },
    moveHighlight: vi.fn(),
    close: vi.fn(),
  };
}

function slashItem(name: string): SlashItem {
  return {
    key: `builtin:${name}`,
    label: `/${name}`,
    selection: { kind: "builtin", name: "plan" },
  };
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    textareaRef: { current: null },
    input: "hello world",
    setInput: vi.fn(),
    mention: makeMatcher(),
    getMentionItems: () => [],
    insertMentionPath: vi.fn(),
    slash: makeMatcher(),
    slashItems: [],
    pickSlashItem: vi.fn(),
    submit: vi.fn(),
    history: {
      messages: [],
      historyIndex: -1,
      setHistoryIndex: vi.fn(),
      historySourceRef: { current: "user" as const },
    },
    cycleMode: vi.fn(),
    ...overrides,
  };
}

describe("buildComposerKeyboardHandler", () => {
  it("Enter submits", () => {
    const deps = makeDeps();
    const handler = buildComposerKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Enter");
    handler(e);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("Ctrl+Enter submits", () => {
    const deps = makeDeps();
    const handler = buildComposerKeyboardHandler(deps);
    const { e } = makeEvent("Enter", { ctrlKey: true });
    handler(e);
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter does not submit (newline)", () => {
    const deps = makeDeps();
    const handler = buildComposerKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Enter", { shiftKey: true });
    handler(e);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("bare Tab does NOT submit and keeps native focus navigation", () => {
    const deps = makeDeps({ input: "some draft text" });
    const handler = buildComposerKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Tab");
    handler(e);
    expect(deps.submit).not.toHaveBeenCalled();
    // preventDefault must not fire so Tab falls through to focus navigation.
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Shift+Tab cycles the mode chip (chat variant)", () => {
    const deps = makeDeps();
    const handler = buildComposerKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Tab", { shiftKey: true });
    handler(e);
    expect(deps.cycleMode).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("Shift+Tab falls through when no cycleMode is wired (launch variant)", () => {
    const deps = makeDeps({ cycleMode: undefined, history: undefined });
    const handler = buildComposerKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("Tab", { shiftKey: true });
    handler(e);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("Alt+. / Alt+, no longer nudge the model", () => {
    const deps = makeDeps();
    const handler = buildComposerKeyboardHandler(deps);
    for (const code of ["Period", "Comma"]) {
      const { e, preventDefault } = makeEvent("≥", { code, altKey: true });
      handler(e);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("Ctrl+S no longer stashes the draft", () => {
    const deps = makeDeps({ input: "a draft worth keeping" });
    const handler = buildComposerKeyboardHandler(deps);
    const { e, preventDefault } = makeEvent("s", { ctrlKey: true });
    handler(e);
    expect(deps.setInput).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  describe("slash popover", () => {
    it("swallows Enter and Tab while open with no matches, dismissing the popover", () => {
      const deps = makeDeps({
        slash: makeMatcher({ active: true, query: "zzz-no-match", prefixIndex: 0 }),
        slashItems: [],
      });
      const handler = buildComposerKeyboardHandler(deps);
      for (const key of ["Enter", "Tab"]) {
        const { e, preventDefault } = makeEvent(key);
        handler(e);
        expect(preventDefault).toHaveBeenCalled();
      }
      expect(deps.submit).not.toHaveBeenCalled();
      expect(deps.pickSlashItem).not.toHaveBeenCalled();
      expect(deps.slash.close).toHaveBeenCalled();
    });

    it("Enter picks the highlighted item from the SAME list the popover renders", () => {
      const items = [slashItem("plan"), slashItem("permissions"), slashItem("model")];
      const deps = makeDeps({
        slash: makeMatcher({
          active: true,
          query: "p",
          prefixIndex: 0,
          highlightedIndex: 1,
        }),
        slashItems: items,
      });
      const handler = buildComposerKeyboardHandler(deps);
      const { e } = makeEvent("Enter");
      handler(e);
      expect(deps.pickSlashItem).toHaveBeenCalledWith(items[1]);
      expect(deps.submit).not.toHaveBeenCalled();
    });

    it("ArrowDown/ArrowUp move the highlight against the shared item count", () => {
      const items = [slashItem("plan"), slashItem("permissions")];
      const slash = makeMatcher({ active: true, query: "p", prefixIndex: 0 });
      const deps = makeDeps({ slash, slashItems: items });
      const handler = buildComposerKeyboardHandler(deps);
      handler(makeEvent("ArrowDown").e);
      expect(slash.moveHighlight).toHaveBeenCalledWith(1, 2);
      handler(makeEvent("ArrowUp").e);
      expect(slash.moveHighlight).toHaveBeenCalledWith(-1, 2);
    });

    it("Escape closes the popover without submitting", () => {
      const slash = makeMatcher({ active: true, query: "p", prefixIndex: 0 });
      const deps = makeDeps({ slash, slashItems: [slashItem("plan")] });
      const handler = buildComposerKeyboardHandler(deps);
      const { e, preventDefault } = makeEvent("Escape");
      handler(e);
      expect(slash.close).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(deps.submit).not.toHaveBeenCalled();
    });
  });

  describe("mention popover", () => {
    it("Enter inserts the highlighted path via the ref list — no DOM dispatch", () => {
      const deps = makeDeps({
        mention: makeMatcher({
          active: true,
          query: "src",
          prefixIndex: 0,
          highlightedIndex: 1,
        }),
        getMentionItems: () => ["src/a.ts", "src/b.ts"],
      });
      const handler = buildComposerKeyboardHandler(deps);
      const { e, preventDefault } = makeEvent("Enter");
      handler(e);
      expect(deps.insertMentionPath).toHaveBeenCalledWith("src/b.ts");
      expect(preventDefault).toHaveBeenCalled();
      expect(deps.submit).not.toHaveBeenCalled();
    });

    it("swallows Enter while results are empty (async scan pending), dismissing the popover", () => {
      const mention = makeMatcher({ active: true, query: "zz", prefixIndex: 0 });
      const deps = makeDeps({ mention, getMentionItems: () => [] });
      const handler = buildComposerKeyboardHandler(deps);
      const { e, preventDefault } = makeEvent("Enter");
      handler(e);
      expect(preventDefault).toHaveBeenCalled();
      expect(deps.submit).not.toHaveBeenCalled();
      expect(mention.close).toHaveBeenCalled();
    });
  });

  describe("prompt history (chat variant)", () => {
    const messages = [
      { id: "m1", role: "user" as const, content: "first", timestamp: 1 },
      { id: "m2", role: "assistant" as const, content: "reply", timestamp: 2 },
      { id: "m3", role: "user" as const, content: "second", timestamp: 3 },
    ];

    it("ArrowUp on an empty composer recalls the most recent user message", () => {
      const setHistoryIndex = vi.fn();
      const setInput = vi.fn();
      const deps = makeDeps({
        input: "",
        setInput,
        history: {
          messages,
          historyIndex: -1,
          setHistoryIndex,
          historySourceRef: { current: "user" as const },
        },
      });
      const handler = buildComposerKeyboardHandler(deps);
      const { e, preventDefault } = makeEvent("ArrowUp");
      handler(e);
      expect(preventDefault).toHaveBeenCalled();
      expect(setHistoryIndex).toHaveBeenCalledWith(0);
      expect(setInput).toHaveBeenCalledWith("second");
    });

    it("ArrowUp does nothing without history deps (launch variant)", () => {
      const deps = makeDeps({ input: "", history: undefined });
      const handler = buildComposerKeyboardHandler(deps);
      const { e, preventDefault } = makeEvent("ArrowUp");
      handler(e);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(deps.setInput).not.toHaveBeenCalled();
    });
  });
});
