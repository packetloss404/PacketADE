import { describe, expect, it } from "vitest";
import { selectRecurringErrorHint } from "@/lib/recurringErrorHint";
import type { LearnedPattern, MemoryEvent } from "@/types/memory";

const pitfall = (id: string, pattern: string): LearnedPattern => ({
  id,
  pattern,
  category: "pitfall",
  confidence: 0.7,
  extractedAt: 1,
});

const flightEvent = (
  id: string,
  flightId: string,
  lessonsLearned: string[],
): MemoryEvent => ({
  id,
  timestamp: 1,
  projectPath: "/p",
  type: "flight_completed",
  payload: {
    flightId,
    flightTitle: "t",
    summary: "s",
    whatWorked: [],
    whatFailed: [],
    lessonsLearned,
    suggestedImprovements: [],
    tags: [],
  },
});

describe("selectRecurringErrorHint (M6)", () => {
  it("returns null for a prompt with no overlapping memory", () => {
    const hint = selectRecurringErrorHint("add a settings toggle", [pitfall("p", "sqlite migrations corrupt the cache")], []);
    expect(hint).toBeNull();
  });

  it("surfaces a matching pitfall pattern", () => {
    const hint = selectRecurringErrorHint(
      "refactor the sqlite migration runner",
      [pitfall("p", "sqlite migration order must be deterministic")],
      [],
    );
    expect(hint?.source).toBe("pitfall");
    expect(hint?.text).toContain("sqlite migration");
  });

  it("surfaces a recurring failure signature and counts occurrences", () => {
    const events = [
      flightEvent("e1", "f1", ["websocket reconnect loops flood the event bus"]),
      flightEvent("e2", "f2", ["websocket reconnect loops flood the event bus"]),
    ];
    const hint = selectRecurringErrorHint("fix the websocket reconnect logic", [], events);
    expect(hint?.source).toBe("failure");
    expect(hint?.occurrences).toBe(2);
  });

  it("prefers the higher-scoring candidate, and a recurring failure outranks a weak pitfall", () => {
    const patterns = [pitfall("p", "avoid the websocket handler entirely")]; // 1 overlap ("websocket")
    const events = [
      flightEvent("e1", "f1", ["websocket reconnect loops flood the event bus"]),
      flightEvent("e2", "f2", ["websocket reconnect loops flood the event bus"]),
    ];
    const hint = selectRecurringErrorHint(
      "fix the websocket reconnect loops in the bus",
      patterns,
      events,
    );
    expect(hint?.source).toBe("failure");
  });

  it("respects the minOverlap threshold", () => {
    // one shared token ("cache") only — below the default threshold of 2
    const hint = selectRecurringErrorHint(
      "clear the cache",
      [pitfall("p", "cache invalidation races with writes on shutdown")],
      [],
    );
    expect(hint).toBeNull();
  });
});
