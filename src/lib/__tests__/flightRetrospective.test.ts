import { describe, expect, it } from "vitest";
import {
  buildFlightSummaryInput,
  buildAttemptSessionLogs,
  parseFlightRetrospective,
} from "@/lib/flightRetrospective";
import type { Attempt, Flight } from "@/types/flight";

const attempt = (over: Partial<Attempt>): Attempt =>
  ({
    id: "a1",
    status: "completed",
    branch: "attempt/x",
    model: "claude",
    agentConfigId: "api-claude",
    target: { kind: "local" },
    ...over,
  }) as Attempt;

const flight = (over: Partial<Flight> = {}): Flight =>
  ({
    id: "f1",
    title: "Refactor auth",
    objective: "Make auth testable",
    status: "done",
    priority: "high",
    projectPath: "/proj",
    createdAt: 0,
    completedAt: 6 * 60_000,
    attempts: [attempt({ id: "a1", status: "completed" }), attempt({ id: "a2", status: "failed" })],
    ...over,
  }) as Flight;

describe("buildFlightSummaryInput (M9)", () => {
  it("maps flight + attempt counts into the DTO with a minutes duration", () => {
    const input = buildFlightSummaryInput(flight());
    expect(input).toMatchObject({
      title: "Refactor auth",
      priority: "high",
      status: "done",
      taskCount: 2,
      tasksDone: 1,
      tasksFailed: 1,
      durationDescription: "6 min",
    });
  });

  it("reports unknown duration when timestamps are missing", () => {
    expect(buildFlightSummaryInput(flight({ completedAt: undefined })).durationDescription).toBe(
      "unknown",
    );
  });
});

describe("buildAttemptSessionLogs (M9)", () => {
  it("renders one line per attempt with the error appended", () => {
    const logs = buildAttemptSessionLogs(
      flight({
        attempts: [attempt({ status: "failed", branch: "b", errorMessage: "boom" })],
      }),
    );
    expect(logs).toBe("[failed] api-claude on b (claude) — boom");
  });
});

describe("parseFlightRetrospective (M9)", () => {
  it("parses a fenced JSON object and coerces string arrays", () => {
    const raw =
      "Here you go:\n```json\n" +
      JSON.stringify({
        summary: "Landed the refactor",
        whatWorked: ["small commits"],
        whatFailed: ["flaky test", 42],
        lessonsLearned: ["pin the seed"],
        suggestedImprovements: [],
        tags: ["auth"],
      }) +
      "\n```";
    const retro = parseFlightRetrospective(raw);
    expect(retro?.summary).toBe("Landed the refactor");
    expect(retro?.lessonsLearned).toEqual(["pin the seed"]);
    expect(retro?.whatFailed).toEqual(["flaky test"]); // non-string dropped
  });

  it("omits fields the model left empty so a merge won't clobber mechanical data", () => {
    // Only summary + lessons present; tags/whatWorked/etc. must be ABSENT keys,
    // not [] — otherwise {...mechanical, ...retro} would erase the flight tag.
    const retro = parseFlightRetrospective(
      JSON.stringify({ summary: "s", lessonsLearned: ["l"], whatWorked: [], tags: [] }),
    );
    expect(retro).not.toBeNull();
    expect("tags" in retro!).toBe(false);
    expect("whatWorked" in retro!).toBe(false);
    expect("suggestedImprovements" in retro!).toBe(false);
    expect(retro).toEqual({ summary: "s", lessonsLearned: ["l"] });
  });

  it("returns null for non-JSON output", () => {
    expect(parseFlightRetrospective("the model refused")).toBeNull();
  });

  it("returns null when the object carries no usable content", () => {
    expect(parseFlightRetrospective(JSON.stringify({ tags: ["x"] }))).toBeNull();
  });
});
