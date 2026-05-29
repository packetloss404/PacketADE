import { describe, expect, it } from "vitest";
import { claimedPathsOverlap, normalizeClaimedPath } from "@/lib/pathCollisions";

describe("path collision helpers", () => {
  it("normalizes case, slashes, repeated separators, and trailing slash", () => {
    expect(normalizeClaimedPath(" .\\SRC\\\\Feature\\ ")).toBe("src/feature");
  });

  it("treats exact and nested paths as collisions", () => {
    expect(claimedPathsOverlap("src/feature", "SRC\\feature\\button.ts")).toBe(true);
    expect(claimedPathsOverlap("src/feature", "src/featurette")).toBe(false);
  });

  it("can preserve case for case-sensitive remote paths", () => {
    expect(claimedPathsOverlap("/repo/Foo", "/repo/foo", { caseSensitive: true })).toBe(false);
  });
});
