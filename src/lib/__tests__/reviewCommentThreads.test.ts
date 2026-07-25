import { describe, expect, it } from "vitest";
import {
  groupCommentThreads,
  lineAnchorKey,
  threadsByAnchor,
  type ReviewComment,
} from "@/lib/reviewCommentThreads";

const c = (over: Partial<ReviewComment> & { id: number }): ReviewComment => ({
  inReplyToId: null,
  user: { login: "u", avatarUrl: "" },
  body: "b",
  path: "src/a.ts",
  line: 10,
  side: "RIGHT",
  createdAt: "2026-01-01T00:00:00Z",
  htmlUrl: "",
  ...over,
});

const key = (path: string, line: number, side: string) => JSON.stringify([path, line, side]);

describe("groupCommentThreads (GP1)", () => {
  it("chains replies under their root", () => {
    const threads = groupCommentThreads([
      c({ id: 1 }),
      c({ id: 2, inReplyToId: 1, createdAt: "2026-01-01T00:01:00Z" }),
      c({ id: 3, inReplyToId: 2, createdAt: "2026-01-01T00:02:00Z" }),
      c({ id: 4, path: "src/b.ts", line: 5 }),
    ]);
    expect(threads).toHaveLength(2);
    const t1 = threads.find((t) => t.root.id === 1)!;
    expect(t1.replies.map((r) => r.id)).toEqual([2, 3]);
  });

  it("survives a dangling parent (treated as its own root)", () => {
    const threads = groupCommentThreads([c({ id: 10, inReplyToId: 999 })]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe(10);
  });
});

describe("lineAnchorKey (GP1)", () => {
  it("keys on path + line + normalized side", () => {
    expect(lineAnchorKey("src/a.ts", 10, "RIGHT")).toBe(key("src/a.ts", 10, "RIGHT"));
    expect(lineAnchorKey("src/a.ts", 10, "left")).toBe(key("src/a.ts", 10, "LEFT"));
    expect(lineAnchorKey("src/a.ts", 10, null)).toBe(key("src/a.ts", 10, "RIGHT"));
  });
  it("returns null for an unplaceable (outdated) comment", () => {
    expect(lineAnchorKey("src/a.ts", null, "RIGHT")).toBeNull();
  });
});

describe("threadsByAnchor (GP1)", () => {
  it("indexes threads by their root's line, dropping unplaceable ones", () => {
    const threads = groupCommentThreads([
      c({ id: 1, path: "src/a.ts", line: 10, side: "RIGHT" }),
      c({ id: 2, path: "src/a.ts", line: 20, side: "LEFT" }),
      c({ id: 3, path: "src/a.ts", line: null }), // outdated
    ]);
    const idx = threadsByAnchor(threads);
    expect([...idx.keys()].sort()).toEqual(
      [key("src/a.ts", 10, "RIGHT"), key("src/a.ts", 20, "LEFT")].sort(),
    );
    expect(idx.get(key("src/a.ts", 10, "RIGHT"))![0].root.id).toBe(1);
  });
});
