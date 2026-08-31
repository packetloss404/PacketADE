import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ptyExitEvent, ptyOutputEvent } from "@/lib/events";

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

// Only the IPC wrappers are mocked. `ptyExitSucceeded` / `parsePtyExitPayload`
// are pure functions with no Tauri call behind them, so they are imported for
// real — stubbing them would mean these tests no longer exercise how an exit
// code becomes a success or a failure, which is the thing worth testing.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([{ id: "pty-x", alive: true }]),
}));

import { runTransientPty } from "@/hooks/useTransientPty";
import { createPtySession, killPty, writePty } from "@/lib/tauri";

const mockCreatePtySession = vi.mocked(createPtySession);
const mockKillPty = vi.mocked(killPty);
const mockWritePty = vi.mocked(writePty);

describe("runTransientPty", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const k of Object.keys(listeners)) delete listeners[k];
    for (const k of Object.keys(unlisteners)) delete unlisteners[k];
    mockCreatePtySession.mockResolvedValue("pty-x");
    mockKillPty.mockResolvedValue(undefined);
    mockWritePty.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures output and resolves when the PTY exits", async () => {
    const run = runTransientPty({ command: "ssh", args: ["host"] });
    // Allow the spawn promise + listener subscriptions to settle.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    listeners[ptyOutputEvent("pty-x")]?.({ payload: "hello\n" });
    listeners[ptyOutputEvent("pty-x")]?.({ payload: "world" });
    listeners[ptyExitEvent("pty-x")]?.({ payload: "0" });

    const result = await run;
    expect(result.completed).toBe(true);
    expect(result.output).toBe("hello\nworld");
    expect(unlisteners[ptyOutputEvent("pty-x")]).toHaveBeenCalledTimes(1);
    expect(unlisteners[ptyExitEvent("pty-x")]).toHaveBeenCalledTimes(1);
    expect(mockKillPty).not.toHaveBeenCalled();
  });

  it("kills the PTY when the timeout elapses without an exit event", async () => {
    const run = runTransientPty({
      command: "ssh",
      args: ["host"],
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    listeners[ptyOutputEvent("pty-x")]?.({ payload: "stuck" });
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await run;
    expect(result.completed).toBe(false);
    expect(result.output).toBe("stuck");
    expect(mockKillPty).toHaveBeenCalledWith("pty-x");
  });

  it("sends initialInput with a trailing CR after spawning", async () => {
    const run = runTransientPty({
      command: "bash",
      initialInput: "echo hi",
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockWritePty).toHaveBeenCalledWith("pty-x", "echo hi\r");
    listeners[ptyExitEvent("pty-x")]?.({ payload: "0" });
    await run;
  });

  // Multi-account: without env forwarding, `claude login` always writes to the
  // ambient config dir and a second account can never be authenticated.
  it("forwards env to createPtySession", async () => {
    const run = runTransientPty({
      command: "claude",
      args: ["login"],
      env: { CLAUDE_CONFIG_DIR: "D:/accts/client" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(mockCreatePtySession).toHaveBeenCalledWith("", 120, 40, "claude", ["login"], {
      CLAUDE_CONFIG_DIR: "D:/accts/client",
    });

    listeners[ptyExitEvent("pty-x")]?.({ payload: "0" });
    await run;
  });

  it("passes null env when the caller supplies none (ambient — unchanged)", async () => {
    const run = runTransientPty({ command: "bash" });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(mockCreatePtySession).toHaveBeenCalledWith("", 120, 40, "bash", null, null);

    listeners[ptyExitEvent("pty-x")]?.({ payload: "0" });
    await run;
  });
});
