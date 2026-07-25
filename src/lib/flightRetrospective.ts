// M9 — rich flight retrospective.
//
// The `summarize_flight` Rust command runs an LLM retrospective over a finished
// flight and returns a JSON object (summary / whatWorked / whatFailed /
// lessonsLearned / suggestedImprovements / tags). These pure helpers build its
// input from a Flight and parse its (possibly fenced) JSON output, so the
// asyncFlightStore capture path can enrich a mechanically-derived
// `flight_completed` payload with model-authored lessons when learning is on.

import type { FlightSummaryInput } from "@/lib/tauri";
import type { Flight, Attempt } from "@/types/flight";
import type { FlightCompletedPayload } from "@/types/memory";

export type FlightRetrospective = Partial<
  Pick<
    FlightCompletedPayload,
    "summary" | "whatWorked" | "whatFailed" | "lessonsLearned" | "suggestedImprovements" | "tags"
  >
>;

function terminalCounts(attempts: Attempt[]) {
  const done = attempts.filter((a) => a.status === "completed").length;
  const failed = attempts.filter((a) => a.status === "failed").length;
  return { done, failed };
}

/** Build the `summarize_flight` input DTO from a finished flight. */
export function buildFlightSummaryInput(flight: Flight): FlightSummaryInput {
  const attempts = flight.attempts ?? [];
  const { done, failed } = terminalCounts(attempts);
  const durationMs =
    flight.completedAt != null && flight.createdAt != null
      ? flight.completedAt - flight.createdAt
      : null;
  const durationDescription =
    durationMs != null ? `${Math.max(1, Math.round(durationMs / 60000))} min` : "unknown";
  return {
    title: flight.title,
    objective: flight.objective,
    priority: flight.priority,
    status: flight.status,
    taskCount: attempts.length,
    tasksDone: done,
    tasksFailed: failed,
    durationDescription,
  };
}

/** A compact, model-readable log of each attempt's outcome (no full transcript
 *  is available here — the branch/model/status/error is the signal we have). */
export function buildAttemptSessionLogs(flight: Flight): string {
  const attempts = flight.attempts ?? [];
  if (attempts.length === 0) return "(no attempts)";
  return attempts
    .map((a) => {
      const err = a.errorMessage ? ` — ${a.errorMessage}` : "";
      return `[${a.status}] ${a.agentConfigId} on ${a.branch} (${a.model})${err}`;
    })
    .join("\n");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Parse the LLM retrospective JSON, tolerating ```json fences and surrounding
 * prose. Returns null when nothing parseable is found or the object yields no
 * usable lessons (so the caller keeps its mechanical payload).
 */
export function parseFlightRetrospective(raw: string): FlightRetrospective | null {
  if (!raw) return null;
  // Grab the first {...} block — run_claude may wrap the JSON in fences/prose.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const lessonsLearned = stringArray(obj.lessonsLearned);
  const whatWorked = stringArray(obj.whatWorked);
  const whatFailed = stringArray(obj.whatFailed);
  const suggestedImprovements = stringArray(obj.suggestedImprovements);
  const tags = stringArray(obj.tags);
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";

  // A retrospective with no lessons and no summary isn't worth overwriting the
  // mechanical payload with.
  if (!lessonsLearned.length && !summary && !whatWorked.length && !whatFailed.length) {
    return null;
  }

  // Only include fields the model actually populated. Empty fields are OMITTED
  // (not returned as [] / "") so the caller's `{...mechanical, ...retro}` merge
  // never erases mechanically-derived data — e.g. the `tags:["flight"]` marker
  // or the completed-attempt `whatWorked` list — when the model leaves a field out.
  const retro: FlightRetrospective = {};
  if (summary) retro.summary = summary;
  if (whatWorked.length) retro.whatWorked = whatWorked;
  if (whatFailed.length) retro.whatFailed = whatFailed;
  if (lessonsLearned.length) retro.lessonsLearned = lessonsLearned;
  if (suggestedImprovements.length) retro.suggestedImprovements = suggestedImprovements;
  if (tags.length) retro.tags = tags;
  return retro;
}
