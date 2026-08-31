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

import { listen } from "@tauri-apps/api/event";
import {
  createPtySession,
  killPty,
  listPtySessions,
  parsePtyExitPayload,
  ptyExitSucceeded,
  writePty,
} from "@/lib/tauri";

const mockListen = vi.mocked(listen);
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

async function startHook(onSessionEnded?: () => void, env?: Record<string, string>) {
  const { term, ref: xtermRef } = createTerminalRef();
  const { fitAddon, ref: fitAddonRef } = createFitAddonRef();
  const sessionIdRef = { current: null } as RefObject<string | null>;

  const hook = renderHook(() =>
    useTerminalSession({
      paneId: "pane-1",
      cliCommand: "claude",
      env,
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

  expect(mockCreatePtySession).toHaveBeenCalledWith(
    "/project-a",
    120,
    40,
    "claude",
    null,
    env ?? null,
  );

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

  it("passes an isolated CLI environment to the PTY backend", async () => {
    const { unmount } = await startHook(undefined, {
      PACKETCODE_HOME: "D:\\PacketCodeData",
    });

    expect(mockCreatePtySession).toHaveBeenCalledWith("/project-a", 120, 40, "claude", null, {
      PACKETCODE_HOME: "D:\\PacketCodeData",
    });
    unmount();
  });

  it("waits for activation, then auto-starts only once across visibility changes", async () => {
    const { ref: xtermRef } = createTerminalRef();
    const { ref: fitAddonRef } = createFitAddonRef();
    const sessionIdRef = { current: null } as RefObject<string | null>;

    const hook = renderHook(
      ({ autoStart }) =>
        useTerminalSession({
          paneId: "pane-gated",
          autoStart,
          cliCommand: "claude",
          projectPath: "/project-a",
          xtermRef,
          fitAddonRef,
          sessionIdRef,
        }),
      { initialProps: { autoStart: false } },
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(mockCreatePtySession).not.toHaveBeenCalled();

    hook.rerender({ autoStart: true });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockCreatePtySession).toHaveBeenCalledTimes(1);

    hook.rerender({ autoStart: false });
    hook.rerender({ autoStart: true });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(mockCreatePtySession).toHaveBeenCalledTimes(1);

    hook.unmount();
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

  it("scores a PTY exit as success or failure", () => {
    // The distinction the terminal pane and the transient runner both hang
    // their "done" vs "error" state on.
    expect(ptyExitSucceeded({ sessionId: "s", exitCode: 0, terminated: false })).toBe(true);
    expect(ptyExitSucceeded({ sessionId: "s", exitCode: 1, terminated: false })).toBe(false);
    expect(ptyExitSucceeded({ sessionId: "s", exitCode: 3221225477, terminated: false })).toBe(
      false,
    );
    // A deliberate kill is not the CLI failing.
    expect(ptyExitSucceeded({ sessionId: "s", exitCode: 137, terminated: true })).toBe(true);
    // Unknown status is an absence of evidence, not evidence of failure —
    // this is also the legacy bare-string payload's shape.
    expect(ptyExitSucceeded({ sessionId: "s", exitCode: null, terminated: false })).toBe(true);
    expect(ptyExitSucceeded("sess-1")).toBe(true);
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

  it("marks a non-zero PTY exit as an error, not a clean finish", async () => {
    // The defect this covers: every `pty:exit` listener used to take no
    // parameter, so a CLI that access-violated on startup produced the same
    // grey "[Session ended]" and the same `done` status as one that worked.
    const { result, unmount } = await startHook();
    expect(result.current.alive).toBe(true);

    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({
        payload: { sessionId: "sess-1", exitCode: 3221225477, terminated: false },
      });
    });

    expect(result.current.alive).toBe(false);
    expect(useTabStore.getState().tabs[0]?.status).toBe("error");

    unmount();
  });

  it("does not score an orchestrator-terminated session as an error", async () => {
    const { result, unmount } = await startHook();

    await act(async () => {
      listeners[ptyExitEvent("sess-1")]?.({
        payload: { sessionId: "sess-1", exitCode: 137, terminated: true },
      });
    });

    expect(result.current.alive).toBe(false);
    expect(useTabStore.getState().tabs[0]?.status).toBe("done");

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

  // The pane can be closed while `createPtySession` is still in flight. The
  // unmount cleanup reads `sessionIdRef`, which is still null at that point, so
  // without an explicit mounted check the resolved spawn leaves a live agent
  // process with no owner — and writes the dead pane's session into layoutStore.
  it("reaps the PTY when the pane unmounts mid-spawn", async () => {
    let resolveSpawn: (id: string) => void = () => {};
    mockCreatePtySession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const { ref: xtermRef } = createTerminalRef();
    const { ref: fitAddonRef } = createFitAddonRef();
    const sessionIdRef = { current: null } as RefObject<string | null>;
    const onSessionCreated = vi.fn();

    const hook = renderHook(() =>
      useTerminalSession({
        paneId: "pane-unmount-mid-spawn",
        cliCommand: "claude",
        projectPath: "/project-a",
        xtermRef,
        fitAddonRef,
        sessionIdRef,
        onSessionCreated,
      }),
    );

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(mockCreatePtySession).toHaveBeenCalledTimes(1);

    hook.unmount();
    expect(mockKillPty).not.toHaveBeenCalled();

    await act(async () => {
      resolveSpawn("sess-orphan");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockKillPty).toHaveBeenCalledWith("sess-orphan");
    expect(sessionIdRef.current).toBeNull();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("drops both PTY listeners when the pane unmounts while they are subscribing", async () => {
    // Typed as `(): void` so they satisfy `UnlistenFn` — a bare `vi.fn()` is a
    // Mock, which does not match that signature under `tsc`.
    const outputUnlisten = vi.fn(() => {});
    const exitUnlisten = vi.fn(() => {});
    let releaseOutputListen: () => void = () => {};
    mockListen
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseOutputListen = () => resolve(outputUnlisten);
          }),
      )
      .mockImplementationOnce(async () => exitUnlisten);

    const { ref: xtermRef } = createTerminalRef();
    const { ref: fitAddonRef } = createFitAddonRef();
    const sessionIdRef = { current: null } as RefObject<string | null>;

    const hook = renderHook(() =>
      useTerminalSession({
        paneId: "pane-unmount-mid-listen",
        cliCommand: "claude",
        projectPath: "/project-a",
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
    expect(sessionIdRef.current).toBe("sess-1");

    hook.unmount();

    await act(async () => {
      releaseOutputListen();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(outputUnlisten).toHaveBeenCalledTimes(1);
    expect(exitUnlisten).toHaveBeenCalledTimes(1);
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
