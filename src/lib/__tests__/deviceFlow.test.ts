import { describe, expect, it, vi } from "vitest";
import {
  deviceFlowNextDelayMs,
  deviceFlowIsTerminal,
  runDeviceFlowAuthorization,
  type DeviceFlowDeps,
} from "@/lib/deviceFlow";
import type { DeviceFlowPoll, DeviceFlowStart } from "@/lib/tauri";

describe("deviceFlowNextDelayMs (GP3)", () => {
  it("holds the interval while pending", () => {
    expect(deviceFlowNextDelayMs("pending", 5000)).toBe(5000);
  });
  it("adds 5s on slow_down", () => {
    expect(deviceFlowNextDelayMs("slow_down", 5000)).toBe(10000);
    expect(deviceFlowNextDelayMs("slow_down", 10000)).toBe(15000);
  });
});

describe("deviceFlowIsTerminal (GP3)", () => {
  it("stops on authorized or error, continues otherwise", () => {
    expect(deviceFlowIsTerminal("authorized")).toBe(true);
    expect(deviceFlowIsTerminal("error")).toBe(true);
    expect(deviceFlowIsTerminal("pending")).toBe(false);
    expect(deviceFlowIsTerminal("slow_down")).toBe(false);
  });
});

/**
 * The loop itself. It used to be hand-rolled inside a Settings card, where it
 * could not be tested at all and where every exit was a `setState` buried in a
 * `while`. Injecting `sleep`/`now` makes all four endings assertable in
 * microseconds, with no clock and no network.
 */
describe("runDeviceFlowAuthorization", () => {
  const START: DeviceFlowStart = {
    deviceCode: "dev-code",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    interval: 5,
    expiresIn: 900,
  };

  function poll(overrides: Partial<DeviceFlowPoll> = {}): DeviceFlowPoll {
    return { status: "pending", message: null, pendingId: null, ...overrides };
  }

  /** A fully injected environment: no clock, no timers, no network. */
  function deps(
    polls: DeviceFlowPoll[],
    opts: { isCancelled?: () => boolean; expiresIn?: number } = {},
  ) {
    let clock = 0;
    const queue = [...polls];
    const d = {
      onCode: vi.fn(),
      isCancelled: opts.isCancelled ?? (() => false),
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      now: () => clock,
      start: vi.fn(async () => ({ ...START, expiresIn: opts.expiresIn ?? START.expiresIn })),
      poll: vi.fn(async () => queue.shift() ?? poll()),
    };
    // Compile-time proof that the fake still satisfies the real contract.
    const asDeps: DeviceFlowDeps = d;
    void asDeps;
    return d;
  }

  it("surfaces the user code before it starts waiting", async () => {
    const d = deps([poll({ status: "authorized", pendingId: "p1" })]);
    await runDeviceFlowAuthorization(d);
    expect(d.onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: START.userCode }));
    // The code is on screen before the first sleep, not after it.
    expect(d.onCode.mock.invocationCallOrder[0]).toBeLessThan(
      d.sleep.mock.invocationCallOrder[0],
    );
  });

  it("returns the handle on authorization — and it is a handle, not a token", async () => {
    const d = deps([poll(), poll({ status: "authorized", pendingId: "pending-42" })]);
    await expect(runDeviceFlowAuthorization(d)).resolves.toEqual({
      kind: "authorized",
      pendingId: "pending-42",
    });
  });

  it("honours the host's interval and backs off when told to slow down", async () => {
    const d = deps([
      poll({ status: "slow_down" }),
      poll(),
      poll({ status: "authorized", pendingId: "p1" }),
    ]);
    await runDeviceFlowAuthorization(d);
    // 5s from `interval`, then +5s for the one slow_down, held after that.
    expect(d.sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 10000]);
  });

  it("reports the host's own explanation for a hard failure", async () => {
    const d = deps([poll({ status: "error", message: "access_denied" })]);
    await expect(runDeviceFlowAuthorization(d)).resolves.toEqual({
      kind: "failed",
      message: "access_denied",
    });
  });

  it("gives up at the host's expiry rather than polling forever", async () => {
    const d = deps([], { expiresIn: 12 });
    await expect(runDeviceFlowAuthorization(d)).resolves.toEqual({ kind: "expired" });
    // 12s of budget at a 5s interval: it keeps polling while the clock is
    // still inside the window (0s, 5s, 10s) and stops at 15s — bounded by the
    // host's expiry, not by an attempt count of its own invention.
    expect(d.sleep).toHaveBeenCalledTimes(3);
  });

  it("stops between polls when the caller stands down", async () => {
    let cancelled = false;
    const d = deps([poll(), poll({ status: "authorized", pendingId: "p1" })], {
      isCancelled: () => cancelled,
    });
    d.sleep.mockImplementation(async () => {
      cancelled = true;
    });
    await expect(runDeviceFlowAuthorization(d)).resolves.toEqual({ kind: "cancelled" });
    expect(d.poll).not.toHaveBeenCalled();
  });

  it("treats an authorization with no handle as a failure, not a success", async () => {
    // A success we cannot verify, commit, or discard is not a success — and
    // silently reporting one would strand a live credential in the backend.
    const d = deps([poll({ status: "authorized", pendingId: null })]);
    const outcome = await runDeviceFlowAuthorization(d);
    expect(outcome.kind).toBe("failed");
  });
});
