import { describe, expect, it } from "vitest";
import { applyAcceptedHunks, parseHunks } from "@/lib/hunkDiff";

/**
 * P1-7: coverage for the keep-list hunk engine (the ONLY hunk engine after
 * the review-surface consolidation). This is file-writing logic —
 * applyAcceptedHunks output goes straight to disk via HunkSelectableDiff.
 */
describe("parseHunks", () => {
  it("returns no hunks for identical content", () => {
    expect(parseHunks("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("coalesces an adjacent remove+add into one replace hunk", () => {
    const orig = "one\ntwo\nthree\n";
    const next = "one\n2\nthree\n";
    const hunks = parseHunks(orig, next);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].startLine).toBe(2);
    expect(hunks[0].originalLines).toEqual(["two"]);
    expect(hunks[0].newLines).toEqual(["2"]);
    expect(hunks[0].context.before).toEqual(["one"]);
    expect(hunks[0].context.after).toEqual(["three"]);
  });

  it("produces one hunk per separated change with correct start lines", () => {
    const orig = "a\nb\nc\nd\ne\nf\ng\n";
    const next = "a\nB\nc\nd\ne\nF\ng\n";
    const hunks = parseHunks(orig, next);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].startLine).toBe(2);
    expect(hunks[0].originalLines).toEqual(["b"]);
    expect(hunks[0].newLines).toEqual(["B"]);
    expect(hunks[1].startLine).toBe(6);
    expect(hunks[1].originalLines).toEqual(["f"]);
    expect(hunks[1].newLines).toEqual(["F"]);
  });

  it("handles pure additions and pure deletions", () => {
    const added = parseHunks("a\nc\n", "a\nb\nc\n");
    expect(added).toHaveLength(1);
    expect(added[0].originalLines).toEqual([]);
    expect(added[0].newLines).toEqual(["b"]);

    const removed = parseHunks("a\nb\nc\n", "a\nc\n");
    expect(removed).toHaveLength(1);
    expect(removed[0].originalLines).toEqual(["b"]);
    expect(removed[0].newLines).toEqual([]);
  });

  it("caps display context at three lines each side", () => {
    const orig = "1\n2\n3\n4\n5\nX\n6\n7\n8\n9\n";
    const next = "1\n2\n3\n4\n5\nY\n6\n7\n8\n9\n";
    const hunks = parseHunks(orig, next);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].context.before).toEqual(["3", "4", "5"]);
    expect(hunks[0].context.after).toEqual(["6", "7", "8"]);
  });
});

describe("applyAcceptedHunks", () => {
  const orig = "a\nb\nc\nd\ne\nf\ng\n";
  const next = "a\nB\nc\nd\ne\nF\ng\n";

  it("accept-all round-trips to the new content", () => {
    const hunks = parseHunks(orig, next);
    const all = new Set(hunks.map((h) => h.id));
    expect(applyAcceptedHunks(orig, hunks, all)).toBe(next);
  });

  it("accept-none returns the original content", () => {
    const hunks = parseHunks(orig, next);
    expect(applyAcceptedHunks(orig, hunks, new Set())).toBe(orig);
  });

  it("accepting a subset applies only those hunks", () => {
    const hunks = parseHunks(orig, next);
    expect(hunks).toHaveLength(2);
    const onlySecond = new Set([hunks[1].id]);
    expect(applyAcceptedHunks(orig, hunks, onlySecond)).toBe(
      "a\nb\nc\nd\ne\nF\ng\n",
    );
  });

  it("round-trips pure additions and deletions", () => {
    const before = "a\nc\n";
    const after = "a\nb\nc\n";
    const addHunks = parseHunks(before, after);
    expect(
      applyAcceptedHunks(before, addHunks, new Set(addHunks.map((h) => h.id))),
    ).toBe(after);

    const delHunks = parseHunks(after, before);
    expect(
      applyAcceptedHunks(after, delHunks, new Set(delHunks.map((h) => h.id))),
    ).toBe(before);
  });

  it("preserves the original's missing trailing newline", () => {
    const before = "a\nb";
    const after = "a\nB";
    const hunks = parseHunks(before, after);
    expect(
      applyAcceptedHunks(before, hunks, new Set(hunks.map((h) => h.id))),
    ).toBe(after);
    expect(applyAcceptedHunks(before, hunks, new Set())).toBe(before);
  });
});
