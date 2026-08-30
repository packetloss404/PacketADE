// GP3: GitHub device-flow polling — cadence, terminal states, and the loop
// itself, kept pure so the UI never owns a hand-rolled `while` over a network
// call again.
//
// SECURITY: nothing here ever holds a credential. `poll` returns a status and,
// on success, an opaque `pendingId` naming a credential that lives in Rust.
// The user code is not a secret (it is meant to be typed into a browser); the
// token it eventually yields never reaches this layer.

import type { DeviceFlowPoll, DeviceFlowStart, DeviceFlowStatus } from "@/lib/tauri";

/** Next poll delay. GitHub's device-flow spec says to add 5s on `slow_down`. */
export function deviceFlowNextDelayMs(status: DeviceFlowStatus, currentMs: number): number {
  return status === "slow_down" ? currentMs + 5000 : currentMs;
}

/** Whether polling should stop (success or hard failure). */
export function deviceFlowIsTerminal(status: DeviceFlowStatus): boolean {
  return status === "authorized" || status === "error";
}

/** How the authorisation ended. `cancelled` is the caller standing down. */
export type DeviceFlowOutcome =
  | { kind: "authorized"; pendingId: string }
  | { kind: "failed"; message: string }
  | { kind: "expired" }
  | { kind: "cancelled" };

export interface DeviceFlowDeps {
  /** Begins the flow; the caller shows the returned user code. */
  start: () => Promise<DeviceFlowStart>;
  poll: (deviceCode: string) => Promise<DeviceFlowPoll>;
  /** Called once with the user-facing code as soon as it exists. */
  onCode: (start: DeviceFlowStart) => void;
  /** Aborts the loop between polls — an unmount, or the user cancelling. */
  isCancelled: () => boolean;
  /** Injected so tests don't wait out a real interval. */
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Drive a device-flow authorisation to one of its four ends.
 *
 * Every exit is a returned value, not a thrown error, so a caller cannot
 * accidentally treat "GitHub said no" as "the call failed" — the two need
 * different copy. Transport errors still throw; those really are exceptional.
 *
 * The loop honours the host's `interval`, backs off on `slow_down`, and stops
 * at the host's own `expires_in` rather than counting its own attempts.
 */
export async function runDeviceFlowAuthorization(
  deps: DeviceFlowDeps,
): Promise<DeviceFlowOutcome> {
  const now = deps.now ?? (() => Date.now());
  const start = await deps.start();
  if (deps.isCancelled()) return { kind: "cancelled" };
  deps.onCode(start);

  let delay = Math.max(start.interval, 1) * 1000;
  const deadline = now() + start.expiresIn * 1000;

  while (now() < deadline) {
    await deps.sleep(delay);
    if (deps.isCancelled()) return { kind: "cancelled" };
    const poll = await deps.poll(start.deviceCode);
    if (deps.isCancelled()) return { kind: "cancelled" };
    delay = deviceFlowNextDelayMs(poll.status, delay);
    if (poll.status === "authorized") {
      // Authorized without a handle would mean the backend saved something we
      // cannot then verify or discard. Treat it as a failure rather than
      // reporting a success we cannot act on.
      if (!poll.pendingId) {
        return { kind: "failed", message: "GitHub authorized the sign-in but returned no handle." };
      }
      return { kind: "authorized", pendingId: poll.pendingId };
    }
    if (deviceFlowIsTerminal(poll.status)) {
      return { kind: "failed", message: poll.message ?? "Authorization failed" };
    }
  }
  return { kind: "expired" };
}
