import { renderHook, act } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import { useActivityStore } from "@/stores/activityStore";
import { useTerminalSession } from "@/hooks/useTerminalSession";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";

const listeners: Record<string, ((event: { payload: unknown }) => void) | undefined> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners[event] = handler;
    return () => {
      delete listeners[event];
    };
  }),
}));

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");

  return {
    ...actual,
    createPtySession: vi.fn(),
    writePty: vi.fn(),
    killPty: vi.fn(),
    readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
    listPtySessions: vi
      .fn()
      .mockResolvedValue([{ id: "sess-1", project_path: "/project-a", pid: 1234, alive: true }]),
  };
});

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

import {
  createPtySession,
  killPty,
  listPtySessions,
  parsePtyExitPayload,
  writePty,
} from "@/lib/tauri";

const mockCreatePtySession = vi.mocked(createPtySession);
const mockKillPty = vi.mocked(killPty);
const mockListPtySessions = vi.mocked(listPtySessions);
const mockWritePty = vi.mocked(writePty);

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

async function startHook(onSessionEnded?: () => void) {
  const { term, ref: xtermRef } = createTerminalRef();
  const { fitAddon, ref: fitAddonRef } = createFitAddonRef();
  const sessionIdRef = { current: null } as RefObject<string | null>;

  const hook = renderHook(() =>
    useTerminalSession({
      paneId: "pane-1",
      cliCommand: "claude",
      projectPath: "/project-a",
      initialPrompt: "hello world",
      issueId: "issue-1",
      xtermRef,
      fitAddonRef,
      sessionIdRef,
      onSessionEnded,
    }),
  );

  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockCreatePtySession).toHaveBeenCalledWith("/project-a", 120, 40, "claude", null);

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
    });
    useTabStore.setState({ tabs: [], activeTabId: null });
    useActivityStore.setState({ activities: {} });

    mockCreatePtySession.mockResolvedValue("sess-1");
    mockKillPty.mockResolvedValue(undefined);
    mockListPtySessions.mockResolvedValue([
      { id: "sess-1", project_path: "/project-a", pid: 1234, alive: true },
    ]);
    mockWritePty.mockResolvedValue(undefined);
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
      listeners[ptyOutputEvent("sess-1")]?.({ payload: ansiChunk });
    });

    expect(term.write).toHaveBeenCalledWith(ansiChunk);

    unmount();
  });

  it("writes the initial prompt and tags the tab with the issue id", async () => {
    const { unmount } = await startHook();

    expect(mockWritePty).toHaveBeenCalledWith("sess-1", "hello world\n");
    expect(useTabStore.getState().tabs[0]?.ticketId).toBe("issue-1");

    unmount();
  });

  it("parses legacy and structured PTY exit payloads", () => {
    expect(parsePtyExitPayload("sess-1")).toEqual({
      sessionId: "sess-1",
      exitCode: null,
      terminated: false,
    });
    expect(parsePtyExitPayload({ sessionId: "sess-1", exitCode: 2, terminated: true })).toEqual({
      sessionId: "sess-1",
      exitCode: 2,
      terminated: true,
    });
  });

  it("marks the session as no longer alive when the PTY exits naturally", async () => {
    const { result, unmount } = await startHook();
    expect(result.current.alive).toBe(true);

    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({
        payload: { sessionId: "sess-1", exitCode: 0, terminated: false },
      });
    });

    expect(result.current.alive).toBe(false);

    unmount();
  });

  it("finishes the session immediately when it has already disappeared before the transcript replay resolves", async () => {
    mockListPtySessions.mockResolvedValueOnce([]);

    const { result, unmount } = await startHook();

    expect(result.current.alive).toBe(false);
    expect(mockWritePty).not.toHaveBeenCalled();

    unmount();
  });

  it("marks the session as not alive after a manual kill followed by the exit event", async () => {
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.handleKill();
    });

    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({ payload: "sess-1" });
    });

    expect(result.current.alive).toBe(false);

    unmount();
  });

  it("emits session ended once when a manual kill races the PTY exit", async () => {
    const onSessionEnded = vi.fn();
    const { result, unmount } = await startHook(onSessionEnded);

    await act(async () => {
      await result.current.handleKill();
    });
    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({ payload: "sess-1" });
    });
    unmount();

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });
});
