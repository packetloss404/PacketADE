import { describe, expect, it } from "vitest";
import { TIMELINE_FILTERS } from "../timelineFilters";

// M10 decision: the dead `task_completed` scheduler path is retired, not
// revived. The Timeline must NOT offer a permanently-empty "Tasks" filter chip,
// while still keeping filters for the event types that are actually emitted.
describe("TIMELINE_FILTERS (M10)", () => {
  it("does not include a task_completed chip", () => {
    expect(TIMELINE_FILTERS.map((f) => f.key)).not.toContain("task_completed");
  });

  it("keeps the filters for the live event types plus 'all'", () => {
    expect(TIMELINE_FILTERS.map((f) => f.key)).toEqual([
      "all",
      "session_completed",
      "flight_completed",
      "manual_note",
    ]);
  });
});
