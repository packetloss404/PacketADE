// M6 — "this looks familiar" recurring-error hint.
//
// At launch time, if the prompt overlaps a known `pitfall` pattern or a lesson
// that has recurred across prior flights, we surface a single one-line warning
// so the user (and the agents) don't re-walk the same rake. Pure and testable:
// the launch modal calls selectRecurringErrorHint(prompt, patterns, events) and
// renders the returned hint, or nothing.

import type { LearnedPattern, MemoryEvent } from "@/types/memory";

export interface RecurringErrorHint {
  text: string;
  source: "pitfall" | "failure";
  /** How many meaningful tokens the prompt shared with the candidate, plus any
   *  recurrence bonus. Higher = more confident it's relevant. */
  score: number;
  /** For a failure signature: how many distinct prior flights hit it. */
  occurrences?: number;
}

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were", "are",
  "not", "but", "you", "your", "our", "its", "into", "out", "off", "via",
  "when", "what", "why", "how", "which", "will", "can", "should", "would",
  "add", "fix", "make", "use", "run", "get", "set", "new",
]);

/** Meaningful (len ≥ 3, non-stopword) lowercased tokens, deduped. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOP.has(raw)) out.add(raw);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Pick the single most relevant recurring-error hint for `prompt`, or null.
 *
 * Candidates are (a) `pitfall`-category learned patterns and (b) lessons drawn
 * from prior `flight_completed` events; a lesson seen across ≥2 flights gets a
 * recurrence bonus (that's the "repeated failure signature"). A candidate only
 * qualifies if it shares at least `minOverlap` meaningful tokens with the prompt.
 */
export function selectRecurringErrorHint(
  prompt: string,
  patterns: LearnedPattern[],
  events: MemoryEvent[],
  opts: { minOverlap?: number } = {},
): RecurringErrorHint | null {
  const minOverlap = opts.minOverlap ?? 2;
  const promptTokens = tokenSet(prompt);
  if (promptTokens.size === 0) return null;

  const candidates: RecurringErrorHint[] = [];

  // (a) pitfall patterns
  for (const p of patterns) {
    if (p.category !== "pitfall") continue;
    const score = overlap(promptTokens, tokenSet(p.pattern));
    if (score >= minOverlap) candidates.push({ text: p.pattern, source: "pitfall", score });
  }

  // (b) failure signatures from flight_completed lessons, counting recurrence
  // across distinct flights.
  const lessonFlights = new Map<string, Set<string>>();
  const lessonText = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "flight_completed") continue;
    const seen = new Set<string>();
    for (const lesson of e.payload.lessonsLearned) {
      const key = lesson.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lessonText.set(key, lesson.trim());
      const set = lessonFlights.get(key) ?? new Set<string>();
      set.add(e.payload.flightId);
      lessonFlights.set(key, set);
    }
  }
  for (const [key, flights] of lessonFlights) {
    const text = lessonText.get(key) ?? key;
    const occurrences = flights.size;
    const base = overlap(promptTokens, tokenSet(text));
    if (base < minOverlap) continue;
    const score = base + (occurrences >= 2 ? 1 : 0);
    candidates.push({ text, source: "failure", score, occurrences });
  }

  if (candidates.length === 0) return null;
  // Highest score wins; ties break toward pitfalls (curated) over raw failures.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source !== b.source) return a.source === "pitfall" ? -1 : 1;
    return 0;
  });
  return candidates[0];
}
