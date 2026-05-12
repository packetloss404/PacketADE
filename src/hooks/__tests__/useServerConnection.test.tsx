import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServerConnection } from "@/hooks/useServerConnection";
import { useServerStore } from "@/stores/serverStore";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";
import type { ServerConfig } from "@/types/server";

const listeners: Record<string, ((event: { payload: unknown }) => void) | undefined> = {};
const unlisteners: Record<string, ReturnType<typeof vi.fn> | undefined> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners[event] = handler;
    const unlisten = vi.fn(() => {
      delete listeners[event];
    });
    unlisteners[event] = unlisten;
    return unlisten;
  }),
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  killPty: vi.fn(),
  saveServersSlice: vi.fn(),
  sshExec: vi.fn(),
}));

import { createPtySession, killPty } from "@/lib/tauri";

const mockCreatePtySession = vi.mocked(createPtySession);
const mockKillPty = vi.mocked(killPty);

const server: ServerConfig = {
  id: "srv-1",
  name: "Test Server",
  host: "example.com",
  port: 22,
  username: "ian",
  authMethod: "agent",
  installedAgents: [],
};

describe("useServerConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const key of Object.keys(listeners)) delete listeners[key];
    for (const key of Object.keys(unlisteners)) delete unlisteners[key];
    useServerStore.setState({
      servers: [server],
      activeServerId: null,
      connectionStates: {},
    });
    mockCreatePtySession.mockResolvedValue("pty-1");
    mockKillPty.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills timed-out PTY probes and unregisters their listeners", async () => {
    const { result } = renderHook(() => useServerConnection());

    let connectPromise!: Promise<void>;
    await act(async () => {
      connectPromise = result.current.connect(server);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      listeners[ptyOutputEvent("pty-1")]?.({ payload: "partial output" });
      await vi.advanceTimersByTimeAsync(15_000);
      await connectPromise;
    });

    expect(mockKillPty).toHaveBeenCalledWith("pty-1");
    expect(unlisteners[ptyOutputEvent("pty-1")]).toHaveBeenCalledTimes(1);
    expect(unlisteners[ptyExitEvent("pty-1")]).toHaveBeenCalledTimes(1);
    expect(useServerStore.getState().connectionStates["srv-1"]?.status).toBe("error");
    expect(useServerStore.getState().connectionStates["srv-1"]?.error).toContain(
      "[Connection timed out]",
    );
  });
});
