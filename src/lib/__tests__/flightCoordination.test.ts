import { describe, expect, it } from "vitest";
import {
  isFlightStuck,
  shouldEscalate,
  stuckSignature,
} from "@/lib/flightCoordination";
import type { Attempt, AttemptStatus, CoordinationEvent } from "@/types/flight";

function attempt(id: string, status: AttemptStatus): Attempt {
  return {
    id,
    flightId: "flight-1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/wt" },
    agentConfigId: "agent-1",
    model: "sonnet",
    provider: "anthropic",
    branch: "b",
    baseBranch: "main",
    sessionId: `sess-${id}`,
    status,
    cost: 0,
    tokens: 0,
  };
}

function escalation(signature: string): CoordinationEvent {
  return {
    id: `coord-${signature}`,
    flightId: "flight-1",
    type: "escalation",
    summary: "stuck",
    timestamp: 1,
    metadata: { signature },
  };
}

describe("isFlightStuck", () => {
  it("is false with no attempts", () => {
    expect(isFlightStuck([])).toBe(false);
  });

  it("is false when any attempt is still active or reviewable", () => {
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "running")])).toBe(false);
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "reviewing")])).toBe(false);
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "completed")])).toBe(false);
    expect(isFlightStuck([attempt("a", "queued")])).toBe(false);
  });

  it("is false when all attempts cancelled but none failed", () => {
    expect(isFlightStuck([attempt("a", "cancelled"), attempt("b", "cancelled")])).toBe(false);
  });

  it("is true when all terminal and at least one failed", () => {
    expect(isFlightStuck([attempt("a", "failed")])).toBe(true);
    expect(isFlightStuck([attempt("a", "failed"), attempt("b", "cancelled")])).toBe(true);
  });
});

describe("stuckSignature", () => {
  it("is order-independent", () => {
    const a = attempt("a", "failed");
    const b = attempt("b", "cancelled");
    expect(stuckSignature([a, b])).toBe(stuckSignature([b, a]));
  });

  it("changes when a new attempt appears (re-run)", () => {
    const first = [attempt("a", "failed")];
    const rerun = [attempt("a", "failed"), attempt("b", "failed")];
    expect(stuckSignature(first)).not.toBe(stuckSignature(rerun));
  });
});

describe("shouldEscalate", () => {
  it("is false when the flight is not stuck", () => {
    expect(shouldEscalate([attempt("a", "running")], [])).toBe(false);
  });

  it("is true for a fresh stuck state with no prior escalation", () => {
    expect(shouldEscalate([attempt("a", "failed")], [])).toBe(true);
  });

  it("dedupes against an existing escalation with the matching signature", () => {
    const attempts = [attempt("a", "failed")];
    const log = [escalation(stuckSignature(attempts))];
    expect(shouldEscalate(attempts, log)).toBe(false);
  });

  it("escalates again after a re-run adds new attempts", () => {
    const first = [attempt("a", "failed")];
    const log = [escalation(stuckSignature(first))];
    const rerun = [attempt("a", "failed"), attempt("b", "failed")];
    expect(shouldEscalate(rerun, log)).toBe(true);
  });

  it("escalates when a cancel completes the stuck state (fail + cancel)", () => {
    // A failed while B was running (not stuck, no escalation yet), then B is
    // cancelled — the flight is now stuck and must still get a suggestion.
    const attempts = [attempt("a", "failed"), attempt("b", "cancelled")];
    expect(shouldEscalate(attempts, [])).toBe(true);
  });
});
