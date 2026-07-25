import { describe, expect, it } from "vitest";
import {
  searchMemoryEvents,
  filterMemoryEventsByScope,
  serializeMemoryExport,
  parseMemoryImport,
  mergeMemoryImport,
  serializeMemoryMarkdown,
} from "@/stores/memoryStore";
import type { MemoryEvent, LearnedPattern } from "@/types/memory";

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

describe("memory export / import (M3)", () => {
  const note = (id: string, summary: string): MemoryEvent => ({
    id,
    timestamp: 1000,
    projectPath: "/p",
    type: "manual_note",
    payload: { source: "test", summary, body: "", tags: [] },
  });
  const pat = (id: string, pattern: string, confidence: number, pinned = false): LearnedPattern => ({
    id,
    pattern,
    category: "convention",
    confidence,
    extractedAt: 1000,
    pinned,
  });

  it("round-trips export → import as identity", () => {
    const events = [note("a", "one"), note("b", "two")];
    const patterns = [pat("p1", "always X", 0.8)];
    const json = serializeMemoryExport(events, patterns);
    const parsed = parseMemoryImport(json);
    expect(parsed).toEqual({ events, patterns });
  });

  it("returns null for invalid JSON", () => {
    expect(parseMemoryImport("not json {")).toBeNull();
  });

  it("drops entries without a string id", () => {
    const json = JSON.stringify({ events: [{ summary: "no id" }, note("a", "one")], patterns: [] });
    const parsed = parseMemoryImport(json);
    expect(parsed?.events.map((e) => e.id)).toEqual(["a"]);
  });

  it("merges deduping by id, existing entries winning", () => {
    const current = { events: [note("a", "existing")], patterns: [pat("p1", "keep", 0.9)] };
    const imported = {
      events: [note("a", "incoming"), note("b", "new")],
      patterns: [pat("p1", "overwrite?", 0.1), pat("p2", "new pattern", 0.5)],
    };
    const merged = mergeMemoryImport(current, imported);
    expect(merged.addedEvents).toBe(1);
    expect(merged.addedPatterns).toBe(1);
    // existing "a" is preserved, not overwritten by the incoming duplicate
    expect(merged.events.find((e) => e.id === "a")?.payload).toMatchObject({ summary: "existing" });
    expect(merged.patterns.find((p) => p.id === "p1")?.pattern).toBe("keep");
    expect(merged.events.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("renders a Markdown digest with counts and pinned markers", () => {
    const md = serializeMemoryMarkdown(
      [note("a", "one")],
      [pat("p1", "high conf", 0.9, true), pat("p2", "low conf", 0.3)],
    );
    expect(md).toContain("# PacketADE memory export");
    expect(md).toContain("- Events: 1");
    expect(md).toContain("- Learned patterns: 2");
    expect(md).toContain("📌 (90%) high conf");
    expect(md).toContain("(30%) low conf");
    // higher confidence sorts first within a category
    expect(md.indexOf("high conf")).toBeLessThan(md.indexOf("low conf"));
  });
});
