// GP3: GitHub device-flow polling cadence — pure so the UI loop is testable.

import type { DeviceFlowStatus } from "@/lib/tauri";

/** Next poll delay. GitHub's device-flow spec says to add 5s on `slow_down`. */
export function deviceFlowNextDelayMs(status: DeviceFlowStatus, currentMs: number): number {
  return status === "slow_down" ? currentMs + 5000 : currentMs;
}

/** Whether polling should stop (success or hard failure). */
export function deviceFlowIsTerminal(status: DeviceFlowStatus): boolean {
  return status === "authorized" || status === "error";
}
