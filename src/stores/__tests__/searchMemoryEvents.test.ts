import { describe, expect, it } from "vitest";
import { searchMemoryEvents } from "@/stores/memoryStore";

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
