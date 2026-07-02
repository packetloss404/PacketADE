import { describe, expect, it, vi } from "vitest";
import {
  createStreamCoalescer,
  type ScheduleFrame,
  type StreamDeltas,
} from "@/lib/streamCoalescer";

/** Manual frame scheduler: flushes only when `fire()` is called, and records
 * schedule/cancel calls so tests can assert one frame per burst. */
function manualScheduler() {
  let pending: (() => void) | null = null;
  let scheduleCount = 0;
  let cancelCount = 0;
  const schedule: ScheduleFrame = (cb) => {
    pending = cb;
    scheduleCount += 1;
    return () => {
      if (pending === cb) pending = null;
      cancelCount += 1;
    };
  };
  const fire = () => {
    const cb = pending;
    pending = null;
    cb?.();
  };
  return {
    schedule,
    fire,
    hasPending: () => pending !== null,
    scheduleCount: () => scheduleCount,
    cancelCount: () => cancelCount,
  };
}

describe("createStreamCoalescer", () => {
  it("buffers a burst of chunks into a single apply per frame, in order", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.pushContent("Hel");
    coalescer.pushContent("lo ");
    coalescer.pushContent("world");
    expect(apply).not.toHaveBeenCalled();
    expect(frames.scheduleCount()).toBe(1);

    frames.fire();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ content: "Hello world", thinking: "" });
  });

  it("coalesces content and thinking deltas into the same flush", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.pushThinking("hmm ");
    coalescer.pushContent("A");
    coalescer.pushThinking("ok");
    coalescer.pushContent("B");

    frames.fire();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ content: "AB", thinking: "hmm ok" });
  });

  it("loses no chunks across consecutive frames", () => {
    const frames = manualScheduler();
    const applied: string[] = [];
    const coalescer = createStreamCoalescer(
      (d) => applied.push(d.content),
      frames.schedule,
    );

    coalescer.pushContent("one");
    frames.fire();
    coalescer.pushContent("two");
    coalescer.pushContent(" three");
    frames.fire();

    expect(applied).toEqual(["one", "two three"]);
    expect(applied.join("")).toBe("onetwo three");
  });

  it("flushNow applies synchronously and the cancelled frame does not double-apply", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.pushContent("tail chunk");
    coalescer.flushNow();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ content: "tail chunk", thinking: "" });

    // Even if the scheduler's cancel were a no-op, a late frame must find an
    // empty buffer and apply nothing.
    frames.fire();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("flushNow with an empty buffer does not apply", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.flushNow();
    expect(apply).not.toHaveBeenCalled();
  });

  it("schedules exactly one frame per burst and reschedules after a flush", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.pushContent("a");
    coalescer.pushThinking("b");
    coalescer.pushContent("c");
    expect(frames.scheduleCount()).toBe(1);

    frames.fire();
    coalescer.pushContent("d");
    expect(frames.scheduleCount()).toBe(2);
    frames.fire();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("empty deltas neither buffer nor schedule", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.pushContent("");
    coalescer.pushThinking("");
    expect(frames.hasPending()).toBe(false);

    coalescer.flushNow();
    expect(apply).not.toHaveBeenCalled();
  });

  it("dispose cancels the pending frame, drops the buffer and ignores later pushes", () => {
    const frames = manualScheduler();
    const apply = vi.fn<(deltas: StreamDeltas) => void>();
    const coalescer = createStreamCoalescer(apply, frames.schedule);

    coalescer.pushContent("doomed");
    coalescer.dispose();
    expect(frames.cancelCount()).toBe(1);

    coalescer.pushContent("after dispose");
    coalescer.flushNow();
    frames.fire();
    expect(apply).not.toHaveBeenCalled();
  });
});
