import { describe, it, expect, beforeEach } from "vitest";
import {
  buildQualityIssueBody,
  buildQualityIssueTitle,
  buildWorkspaceHandoffPrompt,
  clearQualityAISummaryCache,
  deleteQualityAISummaryCache,
  getQualityAISummaryCache,
  labelForCheckName,
  setQualityAISummaryCache,
} from "../qualityAIHelpers";

describe("labelForCheckName", () => {
  it("maps known check names to their canonical label", () => {
    expect(labelForCheckName("lint")).toEqual(["lint"]);
    expect(labelForCheckName("LINT")).toEqual(["lint"]);
    expect(labelForCheckName("typecheck")).toEqual(["typecheck"]);
    expect(labelForCheckName("tsc")).toEqual(["typecheck"]);
    expect(labelForCheckName("type-check")).toEqual(["typecheck"]);
    expect(labelForCheckName("tests")).toEqual(["test-failure"]);
    expect(labelForCheckName("test")).toEqual(["test-failure"]);
    expect(labelForCheckName("build")).toEqual(["build"]);
  });

  it("falls back to a generic quality label for unknown checks", () => {
    expect(labelForCheckName("clippy")).toEqual(["quality"]);
    expect(labelForCheckName("audit")).toEqual(["quality"]);
    expect(labelForCheckName("")).toEqual(["quality"]);
  });
});

describe("buildQualityIssueTitle", () => {
  it("strips the file:line:col prefix and produces a 'Fix {check}: …' title", () => {
    const title = buildQualityIssueTitle(
      "lint",
      "src/foo.ts:42:7 'foo' is defined but never used",
    );
    expect(title).toBe("Fix lint: 'foo' is defined but never used");
  });

  it("truncates very long error messages with a horizontal ellipsis", () => {
    const long = "x".repeat(200);
    const title = buildQualityIssueTitle("build", long);
    expect(title.startsWith("Fix build: ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual("Fix build: ".length + 80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("uses only the first line of multi-line errors", () => {
    const title = buildQualityIssueTitle(
      "typecheck",
      "TS2304: Cannot find name 'foo'.\n  at src/foo.ts:42:7\n  More context...",
    );
    expect(title).toContain("TS2304");
    expect(title).not.toContain("at src/foo.ts");
  });
});

describe("buildQualityIssueBody", () => {
  it("embeds the file locator, command, and error block", () => {
    const body = buildQualityIssueBody(
      {
        id: "e1",
        message: "boom",
        filePath: "src/index.ts",
        line: 42,
        column: 7,
      },
      { name: "lint", command: "pnpm lint" },
    );
    expect(body).toContain("`src/index.ts:42:7`");
    expect(body).toContain("`pnpm lint`");
    expect(body).toContain("```");
    expect(body).toContain("boom");
    expect(body).toContain("Filed from Code Quality");
  });

  it("includes the surrounding-code snippet when supplied", () => {
    const body = buildQualityIssueBody(
      { id: "e1", message: "boom", filePath: "f.rs", line: 1, column: 1 },
      { name: "lint", command: "cargo clippy" },
      "fn main() { foo(); }",
    );
    expect(body).toContain("Surrounding code");
    expect(body).toContain("fn main()");
  });

  it("falls back to bare-path locator when line is 0", () => {
    const body = buildQualityIssueBody(
      { id: "e1", message: "boom", filePath: "src/foo.ts", line: 0, column: 0 },
      { name: "lint", command: "pnpm lint" },
    );
    expect(body).toContain("**Source:** `src/foo.ts`");
    expect(body).not.toContain(":0:0");
  });
});

describe("buildWorkspaceHandoffPrompt", () => {
  it("produces an envelope mentioning the originating check command", () => {
    const prompt = buildWorkspaceHandoffPrompt(
      { id: "e1", message: "oops", filePath: "src/a.ts", line: 5, column: 3 },
      { name: "typecheck", command: "pnpm tsc --noEmit" },
    );
    expect(prompt).toContain("Code Quality failure (typecheck)");
    expect(prompt).toContain("src/a.ts:5:3");
    expect(prompt).toContain("`pnpm tsc --noEmit`");
    expect(prompt).toContain("Please:");
    expect(prompt).toContain("Re-run `pnpm tsc --noEmit`");
  });

  it("includes the surrounding-code section when provided", () => {
    const prompt = buildWorkspaceHandoffPrompt(
      { id: "e1", message: "oops", filePath: "f.ts", line: 1, column: 1 },
      { name: "lint", command: "pnpm lint" },
      "const x = foo;",
    );
    expect(prompt).toContain("Last 50 lines of surrounding code");
    expect(prompt).toContain("const x = foo;");
  });
});

describe("quality AI summary cache", () => {
  beforeEach(() => {
    clearQualityAISummaryCache();
  });

  it("round-trips values via set/get", () => {
    setQualityAISummaryCache("k1", "summary one");
    expect(getQualityAISummaryCache("k1")).toBe("summary one");
  });

  it("returns null for unknown keys", () => {
    expect(getQualityAISummaryCache("does-not-exist")).toBeNull();
  });

  it("deletes a single key without affecting others", () => {
    setQualityAISummaryCache("k1", "a");
    setQualityAISummaryCache("k2", "b");
    deleteQualityAISummaryCache("k1");
    expect(getQualityAISummaryCache("k1")).toBeNull();
    expect(getQualityAISummaryCache("k2")).toBe("b");
  });

  it("clearQualityAISummaryCache wipes everything", () => {
    setQualityAISummaryCache("k1", "a");
    setQualityAISummaryCache("k2", "b");
    clearQualityAISummaryCache();
    expect(getQualityAISummaryCache("k1")).toBeNull();
    expect(getQualityAISummaryCache("k2")).toBeNull();
  });
});
