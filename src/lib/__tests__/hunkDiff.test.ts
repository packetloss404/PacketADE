import { describe, expect, it } from "vitest";
import { applyAcceptedHunks, parseHunks } from "@/lib/hunkDiff";

/**
 * P1-7: coverage for the keep-list hunk engine (the ONLY hunk engine after
 * the review-surface consolidation). This is file-writing logic —
 * applyAcceptedHunks output backs both halves of the canonical review
 * surface: merged content for respondEdit on pending edits, and per-hunk
 * Undo reverts on applied edits.
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

/**
 * P1-8 keep/undo math: the review surface reverts an applied hunk by
 * rebuilding the file from the recorded baseline with every OTHER hunk
 * accepted. These pin the identities that make that safe.
 */
describe("keep/undo math (P1-8 review surface)", () => {
  const baseline = "line1\nline2\nline3\nline4\nline5\n";
  const disk = "line1\nCHANGED2\nline3\nline4\nCHANGED5\nADDED6\n";

  it("accept-all reconstructs the on-disk content exactly (undo's precondition)", () => {
    const hunks = parseHunks(baseline, disk);
    const all = new Set(hunks.map((h) => h.id));
    expect(applyAcceptedHunks(baseline, hunks, all)).toBe(disk);
  });

  it("undoing one hunk restores only that hunk's original lines", () => {
    const hunks = parseHunks(baseline, disk);
    expect(hunks).toHaveLength(2);
    // Undo the first hunk (line2 replace) = accept everything but it.
    const keepAllButFirst = new Set(hunks.slice(1).map((h) => h.id));
    expect(applyAcceptedHunks(baseline, hunks, keepAllButFirst)).toBe(
      "line1\nline2\nline3\nline4\nCHANGED5\nADDED6\n",
    );
    // Undo the second hunk (line5 replace + trailing add) instead.
    const keepAllButSecond = new Set([hunks[0].id]);
    expect(applyAcceptedHunks(baseline, hunks, keepAllButSecond)).toBe(
      "line1\nCHANGED2\nline3\nline4\nline5\n",
    );
  });

  it("undoing every hunk restores the baseline byte-for-byte", () => {
    const hunks = parseHunks(baseline, disk);
    expect(applyAcceptedHunks(baseline, hunks, new Set())).toBe(baseline);
  });

  it("a replace is ONE hunk — both sides can never land together (the old engine's corruption)", () => {
    // PendingEditPrompt's deleted private engine emitted the removed and
    // added runs of a replace as separate selectable units, so accepting
    // both duplicated the region. parseHunks coalesces them: keeping the
    // hunk yields the new side, undoing it the old side — never both.
    const before = "keep\nold line\nkeep2\n";
    const after = "keep\nnew line\nkeep2\n";
    const hunks = parseHunks(before, after);
    expect(hunks).toHaveLength(1);
    const kept = applyAcceptedHunks(before, hunks, new Set([hunks[0].id]));
    const undone = applyAcceptedHunks(before, hunks, new Set());
    expect(kept).toBe(after);
    expect(undone).toBe(before);
    expect(kept).not.toContain("old line");
    expect(undone).not.toContain("new line");
  });
});
