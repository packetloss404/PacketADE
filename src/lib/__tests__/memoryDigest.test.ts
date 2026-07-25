import { describe, expect, it } from "vitest";
import { computeMemoryDigest } from "@/lib/memoryDigest";
import type { LearnedPattern, MemoryEvent } from "@/types/memory";

const now = 1_000_000_000_000;
const day = 24 * 60 * 60_000;

const note = (id: string, ageDays: number): MemoryEvent => ({
  id,
  timestamp: now - ageDays * day,
  projectPath: "/p",
  type: "manual_note",
  payload: { source: "s", summary: id, body: "", tags: [] },
});

const flight = (id: string, ageDays: number, lessons: string[]): MemoryEvent => ({
  id,
  timestamp: now - ageDays * day,
  projectPath: "/p",
  type: "flight_completed",
  payload: {
    flightId: id,
    flightTitle: id,
    summary: "s",
    whatWorked: [],
    whatFailed: [],
    lessonsLearned: lessons,
    suggestedImprovements: [],
    tags: [],
  },
});

const pat = (id: string, category: LearnedPattern["category"], confidence: number, ageDays: number): LearnedPattern => ({
  id,
  pattern: id,
  category,
  confidence,
  extractedAt: now - ageDays * day,
});

describe("computeMemoryDigest (M7)", () => {
  it("counts only events/patterns within the window", () => {
    const events = [note("recent", 2), note("old", 40), flight("f", 5, ["lesson a"])];
    const patterns = [pat("p1", "pitfall", 0.9, 3), pat("p2", "convention", 0.5, 45)];
    const d = computeMemoryDigest(events, patterns, { now, windowDays: 30 });
    expect(d.eventCount).toBe(2); // recent note + flight; old note excluded
    expect(d.byType.manual_note).toBe(1);
    expect(d.byType.flight_completed).toBe(1);
    expect(d.patternCount).toBe(1); // p2 aged out
    expect(d.byCategory.pitfall).toBe(1);
    expect(d.byCategory.convention).toBe(0);
    expect(d.isEmpty).toBe(false);
  });

  it("collects distinct recent lessons and ranks top patterns by confidence", () => {
    const events = [
      flight("f1", 1, ["dup lesson", "unique one"]),
      flight("f2", 2, ["dup lesson"]),
    ];
    const patterns = [
      pat("low", "convention", 0.3, 1),
      pat("high", "pitfall", 0.95, 1),
      pat("mid", "preference", 0.6, 1),
    ];
    const d = computeMemoryDigest(events, patterns, { now, windowDays: 30, topN: 2 });
    expect(d.recentLessons).toEqual(["dup lesson", "unique one"]);
    expect(d.topPatterns.map((p) => p.id)).toEqual(["high", "mid"]);
  });

  it("reports empty when nothing falls in the window", () => {
    const d = computeMemoryDigest([note("old", 90)], [pat("p", "pitfall", 0.9, 90)], {
      now,
      windowDays: 30,
    });
    expect(d.isEmpty).toBe(true);
    expect(d.eventCount).toBe(0);
    expect(d.patternCount).toBe(0);
  });
});
