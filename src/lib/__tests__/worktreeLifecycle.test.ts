import { describe, expect, it } from "vitest";
import {
  canTransitionWorktree,
  isWorktreeDirty,
  isWorktreeSafeToCleanup,
  type WorktreeCleanupFacts,
} from "@/lib/worktreeLifecycle";

function facts(overrides: Partial<WorktreeCleanupFacts> = {}): WorktreeCleanupFacts {
  return {
    dirty: false,
    ancestryMerged: false,
    recordedPrMerged: false,
    commitsAhead: 1,
    ...overrides,
  };
}

describe("worktreeLifecycle.isWorktreeSafeToCleanup — ruled predicate truth table", () => {
  it("clean + ancestry-merged ⇒ safe", () => {
    expect(isWorktreeSafeToCleanup(facts({ ancestryMerged: true }))).toBe(true);
  });

  it("clean + squash-merged via recorded PR ⇒ safe", () => {
    // Ancestry is broken (squash), but the recorded PR reports merged.
    expect(
      isWorktreeSafeToCleanup(facts({ ancestryMerged: false, recordedPrMerged: true })),
    ).toBe(true);
  });

  it("clean + zero commits ahead ⇒ safe", () => {
    expect(isWorktreeSafeToCleanup(facts({ commitsAhead: 0 }))).toBe(true);
  });

  it("dirty ⇒ NEVER safe, even when merged", () => {
    expect(
      isWorktreeSafeToCleanup(
        facts({ dirty: true, ancestryMerged: true, recordedPrMerged: true, commitsAhead: 0 }),
      ),
    ).toBe(false);
  });

  it("clean but unmerged with commits ahead ⇒ not safe (conservative Keep)", () => {
    expect(
      isWorktreeSafeToCleanup(
        facts({ ancestryMerged: false, recordedPrMerged: false, commitsAhead: 3 }),
      ),
    ).toBe(false);
  });
});

describe("worktreeLifecycle.isWorktreeDirty", () => {
  it("empty / whitespace-only status ⇒ clean", () => {
    expect(isWorktreeDirty("")).toBe(false);
    expect(isWorktreeDirty("\n")).toBe(false);
    expect(isWorktreeDirty("   \n  \n")).toBe(false);
  });

  it("any non-blank porcelain line ⇒ dirty", () => {
    expect(isWorktreeDirty(" M src/foo.ts")).toBe(true);
    expect(isWorktreeDirty("?? new.txt\n")).toBe(true);
    expect(isWorktreeDirty("\n M a\n")).toBe(true);
  });
});

describe("worktreeLifecycle.canTransitionWorktree", () => {
  it("active → landed / discarded are legal", () => {
    expect(canTransitionWorktree("active", "landed")).toBe(true);
    expect(canTransitionWorktree("active", "discarded")).toBe(true);
  });

  it("terminal states never transition again", () => {
    expect(canTransitionWorktree("landed", "discarded")).toBe(false);
    expect(canTransitionWorktree("discarded", "landed")).toBe(false);
    expect(canTransitionWorktree("landed", "landed")).toBe(false);
    expect(canTransitionWorktree("active", "active")).toBe(false);
  });
});
