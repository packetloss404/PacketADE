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

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
}));

const attachSessionToTask = vi.fn();
const onTaskApprovalNeeded = vi.fn();
const onTaskApprovalResolved = vi.fn();
const onTaskComplete = vi.fn();

vi.mock("@/stores/orchestrationStore", () => ({
  useOrchestrationStore: {
    getState: vi.fn(() => ({
      attachSessionToTask,
      onTaskApprovalNeeded,
      onTaskApprovalResolved,
      onTaskComplete,
    })),
  },
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

import { createPtySession, killPty, writePty } from "@/lib/tauri";

const mockCreatePtySession = vi.mocked(createPtySession);
const mockKillPty = vi.mocked(killPty);
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

async function startHook() {
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
      taskId: "task-1",
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
      explorerOpen: false,
    });
    useTabStore.setState({ tabs: [], activeTabId: null });
    useActivityStore.setState({ activities: {} });

    mockCreatePtySession.mockResolvedValue("sess-1");
    mockKillPty.mockResolvedValue(undefined);
    mockWritePty.mockResolvedValue(undefined);
    attachSessionToTask.mockReset();
    onTaskApprovalNeeded.mockReset();
    onTaskApprovalResolved.mockReset();
    onTaskComplete.mockReset();
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

  it("writes the initial prompt and links the spawned task session", async () => {
    const { unmount } = await startHook();

    expect(mockWritePty).toHaveBeenCalledWith("sess-1", "hello world\n");
    expect(attachSessionToTask).toHaveBeenCalledWith("task-1", "sess-1");
    expect(useTabStore.getState().tabs[0]?.ticketId).toBe("issue-1");

    unmount();
  });

  it("marks an exited task as complete when the session ends naturally", async () => {
    const { unmount } = await startHook();

    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({ payload: "sess-1" });
    });

    expect(onTaskComplete).toHaveBeenCalledWith("task-1", true);

    unmount();
  });

  it("treats a manually killed session as unsuccessful task completion", async () => {
    const { result, unmount } = await startHook();

    await act(async () => {
      await result.current.handleKill();
    });

    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({ payload: "sess-1" });
    });

    expect(onTaskComplete).toHaveBeenCalledWith("task-1", false);

    unmount();
  });
});
