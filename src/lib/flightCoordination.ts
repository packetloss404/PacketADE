import type { Attempt, CoordinationEvent } from "@/types/flight";
import { useFlightStore } from "@/stores/flightStore";

/**
 * N2 — escalation *suggestions* (never auto-actions) on the flight coordination
 * timeline. Flights run via the attempt-based path; when an attempt fails we
 * record an informational `task_failed` event, and when the flight is left with
 * no path forward (all attempts failed/cancelled, none succeeded) we add one
 * `escalation` suggestion. The suggestion is surfaced in FlightsView's timeline;
 * nothing is reassigned automatically.
 */

const ESCALATION_SUMMARY =
  "No attempt has succeeded — consider reassigning to a different agent, revising the prompt, or reviewing the failures manually.";

function attemptLabel(a: Attempt): string {
  const where = a.target.kind === "ssh" ? a.target.targetId : "local";
  return `${a.provider} (${where})`;
}

function truncate(s: string, max = 140): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * A flight is "stuck" when every attempt is terminal-without-success — all
 * failed or cancelled, with at least one genuine failure. `reviewing`,
 * `completed`, `running`, and `provisioning` all mean a path forward still
 * exists, so those never count as stuck.
 */
export function isFlightStuck(attempts: Attempt[]): boolean {
  if (attempts.length === 0) return false;
  return (
    attempts.every((a) => a.status === "failed" || a.status === "cancelled") &&
    attempts.some((a) => a.status === "failed")
  );
}

/** Signature of the current attempt set, so a re-run (new attempts) escalates
 *  again rather than being deduped against the prior stuck state. */
export function stuckSignature(attempts: Attempt[]): string {
  return attempts
    .map((a) => `${a.id}:${a.status}`)
    .sort()
    .join("|");
}

/** Escalate at most once per stuck state (deduped by signature). */
export function shouldEscalate(attempts: Attempt[], log: CoordinationEvent[]): boolean {
  if (!isFlightStuck(attempts)) return false;
  const sig = stuckSignature(attempts);
  return !log.some((e) => e.type === "escalation" && e.metadata?.signature === sig);
}

/**
 * Evaluate the flight's current state and, if it is now stuck, append one
 * (signature-deduped) `escalation` suggestion. Reads the store fresh so callers
 * can invoke it right after a status patch. Safe to call on any terminal
 * transition (failure OR cancellation) — the stuck/dedup logic decides.
 */
export function maybeEscalate(flightId: string): void {
  const fresh = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!fresh) return;
  const attempts = fresh.attempts ?? [];
  if (!shouldEscalate(attempts, fresh.coordinationLog ?? [])) return;
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "escalation",
    summary: ESCALATION_SUMMARY,
    metadata: { signature: stuckSignature(attempts) },
  });
}

/**
 * On an attempt failure: append an informational `task_failed` event, then — if
 * the flight is now stuck — one `escalation` suggestion. Called from both the
 * runtime terminal listener and the UI reject path.
 */
export function recordAttemptFailure(
  flightId: string,
  attemptId: string,
  errorMessage?: string,
): void {
  const store = useFlightStore.getState();
  const flight = store.flights.find((f) => f.id === flightId);
  if (!flight) return;
  const attempt = flight.attempts?.find((a) => a.id === attemptId);

  store.appendCoordinationEvent(flightId, {
    type: "task_failed",
    taskId: attemptId,
    agentId: attempt?.agentConfigId,
    summary: attempt
      ? `Attempt ${attemptLabel(attempt)} failed${errorMessage ? `: ${truncate(errorMessage)}` : ""}.`
      : `An attempt failed${errorMessage ? `: ${truncate(errorMessage)}` : ""}.`,
  });

  // Re-read (inside maybeEscalate) after the append so escalation is evaluated
  // against the latest attempt statuses and coordination log.
  maybeEscalate(flightId);
}
