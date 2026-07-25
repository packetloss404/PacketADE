// M7 — 30-day memory digest.
//
// A pure aggregation over the memory corpus, windowed to a rolling number of
// days, that MemoryView renders as an at-a-glance "what happened lately" card:
// event counts by type, learned-pattern counts by category, the highest-
// confidence recent patterns, and the freshest flight lessons.

import type {
  LearnedPattern,
  MemoryEvent,
  MemoryEventType,
  PatternCategory,
} from "@/types/memory";

const DAY_MS = 24 * 60 * 60_000;

export interface MemoryDigest {
  windowDays: number;
  eventCount: number;
  byType: Record<MemoryEventType, number>;
  patternCount: number;
  byCategory: Record<PatternCategory, number>;
  topPatterns: LearnedPattern[];
  recentLessons: string[];
  isEmpty: boolean;
}

const EVENT_TYPES: MemoryEventType[] = [
  "session_completed",
  "task_completed",
  "flight_completed",
  "manual_note",
];
const CATEGORIES: PatternCategory[] = ["architecture", "convention", "preference", "pitfall"];

/** Aggregate the last `windowDays` (default 30) of memory into a digest. */
export function computeMemoryDigest(
  events: MemoryEvent[],
  patterns: LearnedPattern[],
  opts: { now: number; windowDays?: number; topN?: number },
): MemoryDigest {
  const windowDays = opts.windowDays ?? 30;
  const topN = opts.topN ?? 5;
  const cutoff = opts.now - windowDays * DAY_MS;

  const byType = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0])) as Record<
    MemoryEventType,
    number
  >;
  const recentLessons: string[] = [];
  let eventCount = 0;
  for (const e of events) {
    if (e.timestamp < cutoff) continue;
    eventCount++;
    byType[e.type]++;
    if (e.type === "flight_completed") {
      for (const lesson of e.payload.lessonsLearned) {
        const trimmed = lesson.trim();
        if (trimmed) recentLessons.push(trimmed);
      }
    }
  }

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<
    PatternCategory,
    number
  >;
  const windowPatterns: LearnedPattern[] = [];
  for (const p of patterns) {
    if (p.extractedAt < cutoff) continue;
    byCategory[p.category]++;
    windowPatterns.push(p);
  }
  const topPatterns = [...windowPatterns]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, topN);

  return {
    windowDays,
    eventCount,
    byType,
    patternCount: windowPatterns.length,
    byCategory,
    topPatterns,
    // De-dup the freshest lessons, newest-first (events aren't ordered, but the
    // set of distinct lessons is what matters for the card).
    recentLessons: [...new Set(recentLessons)].slice(0, topN),
    isEmpty: eventCount === 0 && windowPatterns.length === 0,
  };
}
