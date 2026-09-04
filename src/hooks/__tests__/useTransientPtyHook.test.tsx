import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// `listen` resolves to an `UnlistenFn` — a bare `(): void`. Returning `vi.fn()`
// here does not typecheck (a Mock is not that signature), so the no-op unlisten
// is written out explicitly.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// The exit-classification helpers are pure, so spread the real module rather
// than restubbing them — a hand-written stub would let the hook's outcome
// scoring drift away from the classifier it is supposed to share.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([{ id: "pty-x", alive: true }]),
}));

import { listen } from "@tauri-apps/api/event";
import { useTransientPty } from "@/hooks/useTransientPty";
import { createPtySession, killPty, writePty } from "@/lib/tauri";

const mockListen = vi.mocked(listen);
const mockCreatePtySession = vi.mocked(createPtySession);
const mockKillPty = vi.mocked(killPty);
const mockWritePty = vi.mocked(writePty);

describe("useTransientPty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListen.mockImplementation(async () => () => {});
    mockCreatePtySession.mockResolvedValue("pty-x");
    mockKillPty.mockResolvedValue(undefined);
    mockWritePty.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `TransientPtyModal` calls `start()` from a mount effect, so a dev
  // double-mount fires it twice. Guarding on `sessionIdRef` alone is too late —
  // it is only assigned after the spawn resolves — and the second PTY
  // (`claude login` / `codex login`) overwrites the ref, orphaning the first.
  it("spawns one PTY when start() is called twice before the spawn resolves", async () => {
    let resolveSpawn: (id: string) => void = () => {};
    mockCreatePtySession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const { result } = renderHook(() => useTransientPty({ command: "claude", args: ["login"] }));

    act(() => {
      result.current.start();
      result.current.start();
    });

    expect(mockCreatePtySession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSpawn("pty-x");
    });

    expect(mockCreatePtySession).toHaveBeenCalledTimes(1);
    expect(result.current.sessionId).toBe("pty-x");
  });

  it("kills the PTY when the component unmounts mid-spawn", async () => {
    let resolveSpawn: (id: string) => void = () => {};
    mockCreatePtySession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const { result, unmount } = renderHook(() => useTransientPty({ command: "claude" }));
    act(() => result.current.start());
    unmount();

    await act(async () => {
      resolveSpawn("pty-orphan");
    });

    expect(mockKillPty).toHaveBeenCalledWith("pty-orphan");
  });

  it("drops both PTY listeners when the component unmounts while they subscribe", async () => {
    const outputUnlisten = vi.fn(() => {});
    const exitUnlisten = vi.fn(() => {});
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mockListen
      .mockImplementationOnce(async () => {
        await gate;
        return outputUnlisten;
      })
      .mockImplementationOnce(async () => {
        await gate;
        return exitUnlisten;
      });

    const { result, unmount } = renderHook(() => useTransientPty({ command: "claude" }));

    await act(async () => {
      result.current.start();
    });

    unmount();

    await act(async () => {
      openGate();
      await gate;
    });

    expect(outputUnlisten).toHaveBeenCalledTimes(1);
    expect(exitUnlisten).toHaveBeenCalledTimes(1);
  });
});
