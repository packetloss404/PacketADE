import { describe, expect, it } from "vitest";
import { parseDiff } from "@/components/views/DiffViewer";

const SAMPLE = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 111..222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,4 +10,5 @@ function foo() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
].join("\n");

describe("parseDiff line numbers", () => {
  it("computes old/new line numbers from the hunk header", () => {
    const { lines, files } = parseDiff(SAMPLE);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");

    const body = lines.filter((l) => l.type !== "header");
    // " const a = 1;" — context, both sides at start line 10.
    expect(body[0]).toMatchObject({ type: "context", oldLine: 10, newLine: 10 });
    // "-const b = 2;" — removed, old side only, advances old to 11.
    expect(body[1]).toMatchObject({ type: "remove", oldLine: 11 });
    expect(body[1].newLine).toBeUndefined();
    // "+const b = 3;" — added, new side only (new advanced past the context).
    expect(body[2]).toMatchObject({ type: "add", newLine: 11 });
    expect(body[2].oldLine).toBeUndefined();
    // "+const c = 4;" — added, next new line.
    expect(body[3]).toMatchObject({ type: "add", newLine: 12 });
    // " return a;" — context after the changes: old=12 (only b consumed old),
    // new=13 (two adds consumed new).
    expect(body[4]).toMatchObject({ type: "context", oldLine: 12, newLine: 13 });
  });

  it("does not let a no-newline marker corrupt subsequent line numbers", () => {
    const noNewline = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      " b",
      "-c",
      "\\ No newline at end of file",
      "+c2",
    ].join("\n");
    const { lines } = parseDiff(noNewline);
    const marker = lines.find((l) => l.content.startsWith("\\"));
    // The marker is inert: no line numbers, so anchorForLine treats it as
    // non-commentable.
    expect(marker?.oldLine).toBeUndefined();
    expect(marker?.newLine).toBeUndefined();
    // The added line after the marker keeps the correct new line number (3),
    // not an off-by-one bumped by the marker.
    const added = lines.find((l) => l.type === "add");
    expect(added).toMatchObject({ newLine: 3 });
  });

  it("reports the real path for a deleted file (not /dev/null)", () => {
    const deleted = [
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
    ].join("\n");
    const { files, lines } = parseDiff(deleted);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("gone.ts");
    expect(files[0].status).toBe("deleted");
    // Removed lines anchor to the LEFT/old side.
    const removed = lines.filter((l) => l.type === "remove");
    expect(removed[0]).toMatchObject({ oldLine: 1 });
    expect(removed[0].newLine).toBeUndefined();
  });

  it("does not treat body content lines like `-- x` / `++ x` as file headers", () => {
    // A removed line whose content is `-- removed` becomes the raw diff line
    // `--- removed`; an added `++ added` becomes `+++ added`. These must parse
    // as body lines (not file headers), or line numbering after them corrupts.
    const tricky = [
      "diff --git a/doc.md b/doc.md",
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,3 +1,3 @@",
      " a",
      "--- removed note",
      "+++ added note",
      " b",
    ].join("\n");
    const { lines, files } = parseDiff(tricky);
    expect(files).toHaveLength(1);
    const body = lines.filter((l) => l.type !== "header");
    expect(body[0]).toMatchObject({ type: "context", oldLine: 1, newLine: 1 });
    expect(body[1]).toMatchObject({ type: "remove", oldLine: 2 });
    expect(body[2]).toMatchObject({ type: "add", newLine: 2 });
    // The trailing context line keeps correct numbers despite the tricky lines.
    expect(body[3]).toMatchObject({ type: "context", oldLine: 3, newLine: 3 });
  });

  it("resets counters across multiple hunks", () => {
    const twoHunks = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "@@ -50,1 +51,2 @@",
      " ctx",
      "+added",
    ].join("\n");
    const { lines } = parseDiff(twoHunks);
    const body = lines.filter((l) => l.type !== "header");
    expect(body[0]).toMatchObject({ type: "remove", oldLine: 1 });
    expect(body[1]).toMatchObject({ type: "add", newLine: 1 });
    // Second hunk restarts numbering from its header.
    expect(body[2]).toMatchObject({ type: "context", oldLine: 50, newLine: 51 });
    expect(body[3]).toMatchObject({ type: "add", newLine: 52 });
  });
});
