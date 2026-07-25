// GP2: notifications background-poll cadence. Pure gate so the visibility-aware
// polling decision is testable; the hook wires it to timers + the store.

export const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

/** True once at least `intervalMs` has elapsed since the last poll (or never). */
export function isPollStale(
  lastPolledAt: number | null,
  now: number,
  intervalMs: number,
): boolean {
  return lastPolledAt == null || now - lastPolledAt >= intervalMs;
}

export interface PollDecisionInput {
  connected: boolean;
  /** Document visible — polling pauses while the app is hidden. */
  visible: boolean;
  lastPolledAt: number | null;
  now: number;
  intervalMs: number;
}

/** Whether to fire a notifications poll right now. */
export function shouldPollNotifications({
  connected,
  visible,
  lastPolledAt,
  now,
  intervalMs,
}: PollDecisionInput): boolean {
  return connected && visible && isPollStale(lastPolledAt, now, intervalMs);
}
