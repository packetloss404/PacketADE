import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitStageFiles: vi.fn(),
  gitUnstageFiles: vi.fn(),
  gitCommit: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gitStageFiles: (...args: unknown[]) => mocks.gitStageFiles(...args),
  gitUnstageFiles: (...args: unknown[]) => mocks.gitUnstageFiles(...args),
  gitCommit: (...args: unknown[]) => mocks.gitCommit(...args),
}));

import {
  parseGitStatus,
  pathsForStagingOp,
  stageFile,
  unstageFile,
  stageAllFiles,
  unstageAllFiles,
  commitStaged,
  extractTicketNumber,
  findLinkedIssue,
  type ChangedFile,
} from "@/lib/gitCommitFlow";

function file(overrides: Partial<ChangedFile>): ChangedFile {
  return { status: "M", path: "src/main.rs", staged: false, unstaged: true, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gitStageFiles.mockResolvedValue("");
  mocks.gitUnstageFiles.mockResolvedValue("");
  mocks.gitCommit.mockResolvedValue("[main abc1234] subject");
});

describe("parseGitStatus", () => {
  it("marks a fully-unstaged modification, even as the first line", () => {
    // Regression: the GitDashboard original blob-trimmed the output, eating
    // the leading space of a worktree-only first line (" M foo" parsed as
    // staged with a garbled path). The first line must parse like any other.
    const [f] = parseGitStatus(" M src/foo.ts\nA  bar.ts\n");
    expect(f).toMatchObject({ status: "M", path: "src/foo.ts", staged: false, unstaged: true });
  });

  it("preserves the status columns of every line, first included", () => {
    const files = parseGitStatus("?? zz.ts\n M src/foo.ts\nMM both.ts\n");
    expect(files).toEqual([
      { status: "??", path: "zz.ts", staged: false, unstaged: true },
      { status: "M", path: "src/foo.ts", staged: false, unstaged: true },
      { status: "MM", path: "both.ts", staged: true, unstaged: true },
    ]);
  });

  it("strips trailing carriage returns without touching leading columns", () => {
    const [f] = parseGitStatus(" M src/foo.ts\r\n");
    expect(f).toMatchObject({ status: "M", path: "src/foo.ts", staged: false, unstaged: true });
  });

  it("marks a fully-staged modification", () => {
    const [f] = parseGitStatus("M  src/foo.ts");
    expect(f).toMatchObject({ status: "M", path: "src/foo.ts", staged: true, unstaged: false });
  });

  it("marks a partially-staged file (MM) as both staged and unstaged", () => {
    const [f] = parseGitStatus("MM src/foo.ts");
    expect(f).toMatchObject({ status: "MM", path: "src/foo.ts", staged: true, unstaged: true });
  });

  it("marks an untracked file (??) as unstaged, not staged", () => {
    const [f] = parseGitStatus("?? src/new.ts");
    expect(f).toMatchObject({ status: "??", path: "src/new.ts", staged: false, unstaged: true });
  });

  it("keeps the rename composite path intact", () => {
    const [f] = parseGitStatus("R  old.ts -> new.ts");
    expect(f).toMatchObject({ status: "R", path: "old.ts -> new.ts", staged: true });
  });

  it("returns an empty array for blank output", () => {
    expect(parseGitStatus("")).toEqual([]);
    expect(parseGitStatus("   \n  ")).toEqual([]);
  });
});

describe("pathsForStagingOp", () => {
  it("splits a rename composite into both halves", () => {
    expect(pathsForStagingOp(file({ status: "R", path: "old.ts -> new.ts" }))).toEqual([
      "old.ts",
      "new.ts",
    ]);
  });

  it("returns a single-element array for non-rename statuses", () => {
    expect(pathsForStagingOp(file({ status: "M", path: "src/foo.ts" }))).toEqual(["src/foo.ts"]);
    expect(pathsForStagingOp(file({ status: "??", path: "src/new.ts" }))).toEqual(["src/new.ts"]);
  });
});

describe("stageFile / unstageFile", () => {
  it("stageFile invokes gitStageFiles with the staging-op paths", async () => {
    await stageFile("/repo", file({ status: "R", path: "old.ts -> new.ts" }));
    expect(mocks.gitStageFiles).toHaveBeenCalledWith("/repo", ["old.ts", "new.ts"]);
    expect(mocks.gitUnstageFiles).not.toHaveBeenCalled();
  });

  it("unstageFile invokes gitUnstageFiles with the staging-op paths", async () => {
    await unstageFile("/repo", file({ status: "M", path: "src/foo.ts" }));
    expect(mocks.gitUnstageFiles).toHaveBeenCalledWith("/repo", ["src/foo.ts"]);
    expect(mocks.gitStageFiles).not.toHaveBeenCalled();
  });
});

describe("stageAllFiles / unstageAllFiles", () => {
  it("stageAllFiles makes one batched call containing only unstaged files' paths", async () => {
    const files = [
      file({ status: "M", path: "a.ts", staged: false, unstaged: true }),
      file({ status: "M", path: "b.ts", staged: true, unstaged: false }),
      file({ status: "MM", path: "c.ts", staged: true, unstaged: true }),
    ];
    await stageAllFiles("/repo", files);
    expect(mocks.gitStageFiles).toHaveBeenCalledTimes(1);
    expect(mocks.gitStageFiles).toHaveBeenCalledWith("/repo", ["a.ts", "c.ts"]);
  });

  it("stageAllFiles does not invoke when nothing is unstaged", async () => {
    const files = [file({ status: "M", path: "b.ts", staged: true, unstaged: false })];
    await stageAllFiles("/repo", files);
    expect(mocks.gitStageFiles).not.toHaveBeenCalled();
  });

  it("unstageAllFiles batches over staged files only", async () => {
    const files = [
      file({ status: "M", path: "a.ts", staged: false, unstaged: true }),
      file({ status: "M", path: "b.ts", staged: true, unstaged: false }),
      file({ status: "MM", path: "c.ts", staged: true, unstaged: true }),
    ];
    await unstageAllFiles("/repo", files);
    expect(mocks.gitUnstageFiles).toHaveBeenCalledTimes(1);
    expect(mocks.gitUnstageFiles).toHaveBeenCalledWith("/repo", ["b.ts", "c.ts"]);
  });

  it("unstageAllFiles does not invoke when nothing is staged", async () => {
    const files = [file({ status: "M", path: "a.ts", staged: false, unstaged: true })];
    await unstageAllFiles("/repo", files);
    expect(mocks.gitUnstageFiles).not.toHaveBeenCalled();
  });

  it("expands renames when batching", async () => {
    const files = [file({ status: "R", path: "old.ts -> new.ts", staged: false, unstaged: true })];
    await stageAllFiles("/repo", files);
    expect(mocks.gitStageFiles).toHaveBeenCalledWith("/repo", ["old.ts", "new.ts"]);
  });
});

describe("commitStaged", () => {
  it("always passes stageAll=false and forwards message/context", async () => {
    const context = { flightId: "f1", taskId: null, attemptId: null, conversationId: null, sessionId: null };
    await commitStaged("/repo", "  fix: thing  ", context);
    expect(mocks.gitCommit).toHaveBeenCalledWith("/repo", "fix: thing", false, context);
  });

  it("passes null context when none is given", async () => {
    await commitStaged("/repo", "fix: thing");
    expect(mocks.gitCommit).toHaveBeenCalledWith("/repo", "fix: thing", false, null);
  });

  it("rejects an empty message without invoking gitCommit", async () => {
    await expect(commitStaged("/repo", "")).rejects.toThrow("Commit message is required");
    expect(mocks.gitCommit).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only message without invoking gitCommit", async () => {
    await expect(commitStaged("/repo", "   \n  ")).rejects.toThrow("Commit message is required");
    expect(mocks.gitCommit).not.toHaveBeenCalled();
  });
});

describe("end-to-end staging -> commit ordering", () => {
  it("stages files before committing, in call order", async () => {
    const calls: string[] = [];
    mocks.gitStageFiles.mockImplementation(async () => {
      calls.push("stage");
      return "";
    });
    mocks.gitCommit.mockImplementation(async () => {
      calls.push("commit");
      return "[main abc1234] subject";
    });

    await stageFile("/repo", file({ status: "M", path: "a.ts" }));
    await stageFile("/repo", file({ status: "A", path: "b.ts" }));
    await commitStaged("/repo", "feat: land work");

    expect(calls).toEqual(["stage", "stage", "commit"]);
    expect(mocks.gitStageFiles).toHaveBeenCalledTimes(2);
    expect(mocks.gitCommit).toHaveBeenCalledTimes(1);
  });
});

describe("extractTicketNumber", () => {
  it("extracts the trailing numeric suffix", () => {
    expect(extractTicketNumber("PKT-042")).toBe(42);
  });

  it("returns null when there is no numeric suffix", () => {
    expect(extractTicketNumber("PKT-abc")).toBeNull();
    expect(extractTicketNumber("")).toBeNull();
  });
});

interface TestIssue {
  ticketId: string;
  title: string;
  status: string;
  workspaceId?: string;
}

function issue(overrides: Partial<TestIssue>): TestIssue {
  return { ticketId: "PKT-001", title: "Fix thing", status: "todo", workspaceId: "ws-1", ...overrides };
}

describe("findLinkedIssue", () => {
  it("picks the smallest ticket number among candidates", () => {
    const issues = [
      issue({ ticketId: "PKT-042", title: "Bigger" }),
      issue({ ticketId: "PKT-007", title: "Smaller" }),
    ];
    const result = findLinkedIssue(issues, "ws-1");
    expect(result?.num).toBe(7);
    expect(result?.issue.title).toBe("Smaller");
  });

  it("skips done and cancelled issues", () => {
    const issues = [
      issue({ ticketId: "PKT-001", status: "done" }),
      issue({ ticketId: "PKT-002", status: "cancelled" }),
      issue({ ticketId: "PKT-003", status: "in_progress" }),
    ];
    const result = findLinkedIssue(issues, "ws-1");
    expect(result?.num).toBe(3);
  });

  it("skips issues with non-numeric ticket ids", () => {
    const issues = [issue({ ticketId: "PKT-abc" }), issue({ ticketId: "PKT-005" })];
    const result = findLinkedIssue(issues, "ws-1");
    expect(result?.num).toBe(5);
  });

  it("returns null for an unmatched workspace id", () => {
    const issues = [issue({ workspaceId: "ws-1" })];
    expect(findLinkedIssue(issues, "ws-2")).toBeNull();
  });

  it("returns null when workspaceId is null or undefined", () => {
    const issues = [issue({ workspaceId: "ws-1" })];
    expect(findLinkedIssue(issues, null)).toBeNull();
    expect(findLinkedIssue(issues, undefined)).toBeNull();
  });
});
