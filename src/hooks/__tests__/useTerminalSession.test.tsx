import { renderHook, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import { useActivityStore } from "@/stores/activityStore";
import { useTerminalSession } from "@/hooks/useTerminalSession";

const listeners: Record<string, ((event: { payload: unknown }) => void) | undefined> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners[event] = handler;
    return () => {
      delete listeners[event];
    };
  }),
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
}));

vi.mock("@/hooks/usePtyStateDetector", () => ({
  usePtyStateDetector: vi.fn(() => ({
    clearApproval: vi.fn(),
  })),
}));

vi.mock("@/lib/notifications", () => ({
  notifyApprovalNeeded: vi.fn(),
  notifySessionComplete: vi.fn(),
  notifySessionError: vi.fn(),
}));

import { createPtySession, killPty } from "@/lib/tauri";

const mockCreatePtySession = vi.mocked(createPtySession);
const mockKillPty = vi.mocked(killPty);

function createTerminalRef() {
  const term = {
    cols: 120,
    rows: 40,
    reset: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
  } as unknown as Terminal;

  return {
    term,
    ref: { current: term } as unknown as RefObject<Terminal | null>,
  };
}

function createFitAddonRef() {
  const fitAddon = {
    fit: vi.fn(),
  } as unknown as FitAddon;

  return {
    fitAddon,
    ref: { current: fitAddon } as unknown as RefObject<FitAddon | null>,
  };
}

async function startHook() {
  const { term, ref: xtermRef } = createTerminalRef();
  const { fitAddon, ref: fitAddonRef } = createFitAddonRef();
  const sessionIdRef = { current: null } as RefObject<string | null>;

  const hook = renderHook(() =>
    useTerminalSession({
      paneId: "pane-1",
      cliCommand: "claude",
      xtermRef,
      fitAddonRef,
      sessionIdRef,
    }),
  );

  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockCreatePtySession).toHaveBeenCalledWith("/workspace", 120, 40, "claude", null);

  return { ...hook, term, fitAddon };
}

describe("useTerminalSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    for (const key of Object.keys(listeners)) {
      delete listeners[key];
    }

    useLayoutStore.setState({
      panes: [],
      activePaneId: "",
      projectPath: "/workspace",
      explorerOpen: false,
    });
    useTabStore.setState({ tabs: [], activeTabId: null });
    useActivityStore.setState({ activities: {} });

    mockCreatePtySession.mockResolvedValue("sess-1");
    mockKillPty.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resets xterm state before starting a session", async () => {
    const { term, unmount } = await startHook();

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.clear).not.toHaveBeenCalled();

    unmount();
  });

  it("writes PTY output to xterm without altering ANSI sequences", async () => {
    const { term, unmount } = await startHook();
    const ansiChunk = "\x1b[31mred\x1b[0m\r\n";

    await act(async () => {
      listeners["pty:output"]?.({
        payload: {
          session_id: "sess-1",
          data: ansiChunk,
        },
      });
    });

    expect(term.write).toHaveBeenCalledWith(ansiChunk);

    unmount();
  });
});
