/**
 * Perf-gate fallback (P3-S3): the 4 Hz batched `ScheduleFrame` proven
 * END-TO-END through the REAL `streamCoalescer` (injection only — the coalescer
 * is untouched). This is the named fallback for the N-stream gate: if 4
 * concurrent streams ever breach p95 frame < 16 ms, non-focused tiles swap
 * their per-frame scheduler for this one and re-run the gate. The path is
 * unit-tested here even though the gate passes, so the fallback is proven, not
 * speculative.
 */
import { describe, expect, it } from "vitest";
import { createStreamCoalescer, type StreamDeltas } from "@/lib/streamCoalescer";
import {
  createBatchedScheduleFrame,
  FALLBACK_FLUSH_HZ,
  FALLBACK_FLUSH_INTERVAL_MS,
} from "@/lib/streamFallbackScheduler";

/** Deterministic manual clock + timer queue (no real timers, no rAF). */
function makeClock() {
  let t = 0;
  let nextId = 1;
  const timers: { at: number; cb: () => void; id: number }[] = [];
  return {
    now: () => t,
    setTimer: ((cb: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: t + ms, cb, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimer: ((handle: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((x) => x.id === (handle as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    }),
    advance: (ms: number) => {
      t += ms;
      // Fire every timer due at-or-before the new time, in scheduled order.
      for (;;) {
        const due = timers
          .filter((x) => x.at <= t)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.cb();
      }
    },
  };
}

describe("createBatchedScheduleFrame (4 Hz fallback)", () => {
  it("exposes the ruled 4 Hz / 250 ms constants", () => {
    expect(FALLBACK_FLUSH_HZ).toBe(4);
    expect(FALLBACK_FLUSH_INTERVAL_MS).toBe(250);
  });

  it("caps a coalescer to one flush per interval, batching everything in the window in order", () => {
    const clock = makeClock();
    const applied: StreamDeltas[] = [];
    const coalescer = createStreamCoalescer(
      (d) => applied.push(d),
      createBatchedScheduleFrame(250, {
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      }),
    );

    // First delta flushes immediately (no artificial delay before first token).
    coalescer.pushContent("a");
    clock.advance(0);
    expect(applied).toEqual([{ content: "a", thinking: "" }]);

    // A burst within the next 250 ms window batches into a SINGLE flush,
    // preserving arrival order.
    coalescer.pushContent("b");
    coalescer.pushContent("c");
    clock.advance(100);
    expect(applied).toHaveLength(1); // not yet — window not elapsed
    coalescer.pushContent("d");
    clock.advance(150); // t = 250 → the one batched flush fires
    expect(applied).toEqual([
      { content: "a", thinking: "" },
      { content: "bcd", thinking: "" },
    ]);
  });

  it("holds streaming to ~4 flushes/sec no matter how fast deltas arrive", () => {
    const clock = makeClock();
    const applied: StreamDeltas[] = [];
    const coalescer = createStreamCoalescer(
      (d) => applied.push(d),
      createBatchedScheduleFrame(FALLBACK_FLUSH_INTERVAL_MS, {
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      }),
    );

    // 1000 ms of streaming, a delta every 10 ms (100 pushes). A per-frame
    // scheduler could flush ~60×; the 4 Hz fallback caps it.
    for (let i = 0; i < 100; i++) {
      coalescer.pushContent("x");
      clock.advance(10);
    }
    coalescer.flushNow();

    // Over one second at 4 Hz: at most ~4-5 flushes (first-immediate + 4).
    expect(applied.length).toBeLessThanOrEqual(5);
    // No delta is lost or reordered: concatenation is the full stream.
    expect(applied.map((d) => d.content).join("")).toBe("x".repeat(100));
  });

  it("flushNow still lands synchronously through the injected scheduler", () => {
    const clock = makeClock();
    const applied: StreamDeltas[] = [];
    const coalescer = createStreamCoalescer(
      (d) => applied.push(d),
      createBatchedScheduleFrame(250, {
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      }),
    );
    coalescer.pushContent("tail");
    coalescer.flushNow(); // settling turn must not wait for the 250 ms window
    expect(applied).toEqual([{ content: "tail", thinking: "" }]);
  });
});
