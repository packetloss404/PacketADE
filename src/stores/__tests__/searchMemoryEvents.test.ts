import { describe, expect, it } from "vitest";
import { searchMemoryEvents, filterMemoryEventsByScope } from "@/stores/memoryStore";

// searchMemoryEvents only reads `.payload` (JSON-stringified), so a minimal
// shape is enough to exercise the ranker.
const ev = (id: string, text: string) => ({ id, payload: { text } });

describe("searchMemoryEvents (M1)", () => {
  it("returns the input array unchanged for a blank query", () => {
    const events = [ev("a", "hello"), ev("b", "world")];
    expect(searchMemoryEvents(events, "   ")).toBe(events);
  });

  it("ranks a strongly-matching event above a weakly-matching one", () => {
    const events = [
      ev("weak", "the database migration ran once"),
      ev("strong", "authentication token refresh failed with an authentication error"),
    ];
    const out = searchMemoryEvents(events, "authentication token refresh");
    expect(out[0].id).toBe("strong");
  });

  it("keeps a substring-only match the IDF tokenizer would miss", () => {
    // "bc12" is not a whole token in "abc123", but it is a substring — the old
    // naive search would have found it, so we must not drop it.
    const events = [ev("x", "code abc123 here")];
    expect(searchMemoryEvents(events, "bc12").map((e) => e.id)).toEqual(["x"]);
  });

  it("drops events that match neither by token nor substring", () => {
    const events = [ev("a", "database schema notes"), ev("b", "completely unrelated")];
    expect(searchMemoryEvents(events, "database").map((e) => e.id)).toEqual(["a"]);
  });
});

describe("filterMemoryEventsByScope (M2)", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60_000;
  const e = (id: string, projectPath: string, ageMs: number) => ({
    id,
    projectPath,
    timestamp: now - ageMs,
  });

  it("keeps everything with the default (all / null) scope", () => {
    const events = [e("a", "/p1", 0), e("b", "/p2", 100 * day)];
    expect(filterMemoryEventsByScope(events, { now }).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("filters by project path", () => {
    const events = [e("a", "/p1", 0), e("b", "/p2", 0)];
    expect(filterMemoryEventsByScope(events, { project: "/p1", now }).map((x) => x.id)).toEqual([
      "a",
    ]);
  });

  it("drops events older than the date window", () => {
    const events = [e("recent", "/p", 2 * day), e("old", "/p", 40 * day)];
    expect(filterMemoryEventsByScope(events, { dateRange: "30d", now }).map((x) => x.id)).toEqual([
      "recent",
    ]);
  });

  it("composes project + date window", () => {
    const events = [e("a", "/p1", 2 * day), e("b", "/p2", 2 * day), e("c", "/p1", 40 * day)];
    expect(
      filterMemoryEventsByScope(events, { project: "/p1", dateRange: "30d", now }).map((x) => x.id),
    ).toEqual(["a"]);
  });
});
