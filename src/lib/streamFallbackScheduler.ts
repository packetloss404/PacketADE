/**
 * Named perf-gate fallback: 4 Hz batched frame scheduling for streaming tiles.
 *
 * The N-stream perf gate (Phase 3) ships on the landed rAF `streamCoalescer`
 * (`src/lib/streamCoalescer.ts`) + zustand referential isolation + lazy
 * MessageList rows. If that gate is ever breached on real hardware (4 concurrent
 * streams in a 2×2 mosaic hold p95 frame < 16 ms), the RULED fallback is:
 *
 *   non-focused streaming tiles coalesce to 4 Hz batched flushes via the
 *   injectable `ScheduleFrame` (streamCoalescer is injectable by design —
 *   `createStreamCoalescer(apply, scheduleFrame)`); the focused tile stays
 *   per-frame; then the gate re-runs.
 *
 * This module provides that injectable scheduler WITHOUT touching
 * `streamCoalescer.ts` (injection only — the coalescer's flush semantics and
 * ordering guarantees are untouched). It is a drop-in `ScheduleFrame`: a
 * coalescer built with it flushes at most once per `intervalMs`, batching every
 * delta that arrived in the window into a single store write.
 *
 * The scheduler is dormant in production while the gate passes (see the perf
 * harness in `src/lib/__tests__/streamPerfGate.test.ts`); it is nonetheless
 * unit-tested end-to-end through the real coalescer so the fallback path is
 * proven, not speculative.
 */

import type { ScheduleFrame } from "./streamCoalescer";

/** 4 Hz — the ruled batched-flush rate for non-focused streaming tiles. */
export const FALLBACK_FLUSH_HZ = 4;
export const FALLBACK_FLUSH_INTERVAL_MS = 1000 / FALLBACK_FLUSH_HZ; // 250 ms

export interface BatchedScheduleFrameOptions {
  /** Injectable clock (defaults to `performance.now` / `Date.now`). Test seam. */
  now?: () => number;
  /**
   * Injectable timer. Must match `setTimeout`/`clearTimeout` shape. Test seam
   * for fake timers; defaults to the global timer.
   */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Build a `ScheduleFrame` that fires its callback at most once per
 * `intervalMs`, aligned to the previous fire so consecutive flushes are always
 * ≥ `intervalMs` apart. A coalescer created with this scheduler therefore lands
 * at most `1000 / intervalMs` store writes per second regardless of how fast
 * deltas arrive — the "coalesce to 4 Hz" fallback behaviour.
 *
 * The coalescer only ever has one flush scheduled at a time (its own `schedule`
 * guard), so this scheduler just needs to delay each requested flush to the
 * next interval boundary; it does not itself de-duplicate.
 */
export function createBatchedScheduleFrame(
  intervalMs: number = FALLBACK_FLUSH_INTERVAL_MS,
  options: BatchedScheduleFrameOptions = {},
): ScheduleFrame {
  const nowFn =
    options.now ??
    (typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now());
  const setTimer =
    options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle));

  // -Infinity so the very first flush fires immediately (no artificial delay
  // before the first token lands).
  let lastFire = -Infinity;

  return (cb) => {
    const elapsed = nowFn() - lastFire;
    const delay = elapsed >= intervalMs ? 0 : intervalMs - elapsed;
    const handle = setTimer(() => {
      lastFire = nowFn();
      cb();
    }, delay);
    return () => clearTimer(handle);
  };
}
