/**
 * The delete confirm's copy is the whole point of the "Discard, surface the
 * confirm" decision — if these strings stop naming the worktree, the branch, or
 * (loudest) the uncommitted changes, the user is back to losing work silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getGitStatusMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  getGitStatus: (...args: unknown[]) => getGitStatusMock(...args),
}));

import {
  conversationWorktree,
  inspectConversationWorktree,
  worktreeDeleteConfirmLabel,
  worktreeDeleteWarnings,
} from "@/lib/conversationWorktreeDisclosure";
import type { AgentConversation } from "@/types/agent-conversation";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Fix login",
    agent: "api-openai",
    projectPath: "/repo/.pkt-worktrees/conv-1",
    status: "idle",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 2,
    mode: "api",
    worktree: {
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-1",
      branch: "pkt/conv-1",
      createdAt: 1,
      state: "active",
    },
    ...overrides,
  } as AgentConversation;
}

beforeEach(() => {
  vi.clearAllMocks();
  getGitStatusMock.mockResolvedValue("");
});

describe("conversationWorktree", () => {
  it("resolves the worktree a delete would discard", () => {
    expect(conversationWorktree(conv())).toEqual({
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-1",
      branch: "pkt/conv-1",
    });
  });

  it("derives provenance for a legacy worktree conversation with no stamped record", () => {
    expect(conversationWorktree(conv({ worktree: undefined }))).toEqual({
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-1",
      branch: "pkt/conv-1",
    });
  });

  it("returns null for a root-run conversation, an SSH conversation, and an already-discarded tree", () => {
    expect(conversationWorktree(conv({ projectPath: "/repo", worktree: undefined }))).toBeNull();
    expect(
      conversationWorktree(
        conv({ sshTarget: { id: "s", name: "n", host: "h", user: "u", remotePath: "/r" } }),
      ),
    ).toBeNull();
    expect(
      conversationWorktree(
        conv({
          worktree: {
            basePath: "/repo",
            worktreePath: "/repo/.pkt-worktrees/conv-1",
            branch: "pkt/conv-1",
            createdAt: 1,
            state: "discarded",
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("inspectConversationWorktree", () => {
  it("reports a clean tree as clean", async () => {
    await expect(inspectConversationWorktree(conv())).resolves.toMatchObject({
      dirty: false,
      dirtyUnknown: false,
    });
    expect(getGitStatusMock).toHaveBeenCalledWith("/repo/.pkt-worktrees/conv-1");
  });

  it("reports uncommitted changes", async () => {
    getGitStatusMock.mockResolvedValue(" M src/foo.ts\n?? new.txt\n");
    await expect(inspectConversationWorktree(conv())).resolves.toMatchObject({ dirty: true });
  });

  it("treats an UNKNOWN dirty-check as possibly dirty rather than clean", async () => {
    getGitStatusMock.mockRejectedValue(new Error("not a git repo"));
    await expect(inspectConversationWorktree(conv())).resolves.toMatchObject({
      dirty: true,
      dirtyUnknown: true,
    });
  });

  it("skips the git call entirely when there is no worktree", async () => {
    await expect(
      inspectConversationWorktree(conv({ projectPath: "/repo", worktree: undefined })),
    ).resolves.toBeNull();
    expect(getGitStatusMock).not.toHaveBeenCalled();
  });
});

describe("worktreeDeleteWarnings", () => {
  const base = {
    basePath: "/repo",
    worktreePath: "/repo/.pkt-worktrees/conv-1",
    branch: "pkt/conv-1",
  };

  it("leads with UNCOMMITTED CHANGES for a dirty tree, then names path and branch", () => {
    const lines = worktreeDeleteWarnings({ ...base, dirty: true, dirtyUnknown: false });
    expect(lines[0]).toBe("This worktree has UNCOMMITTED CHANGES. They will be permanently lost.");
    expect(lines[1]).toBe("Worktree /repo/.pkt-worktrees/conv-1 will be deleted from disk.");
    expect(lines[2]).toBe("Branch pkt/conv-1 will be force-deleted.");
  });

  it("still warns about unmerged commits on a clean tree", () => {
    const lines = worktreeDeleteWarnings({ ...base, dirty: false, dirtyUnknown: false });
    expect(lines[0]).toBe(
      "No uncommitted changes, but any commits on this branch that were never merged are lost.",
    );
    expect(lines).toHaveLength(3);
  });

  it("says so when it could not check", () => {
    const lines = worktreeDeleteWarnings({ ...base, dirty: true, dirtyUnknown: true });
    expect(lines[0]).toMatch(/Could not check for uncommitted changes/);
  });

  it("shows NOTHING when the conversation has no worktree", () => {
    expect(worktreeDeleteWarnings(null)).toEqual([]);
  });
});

describe("worktreeDeleteConfirmLabel", () => {
  const base = {
    basePath: "/repo",
    worktreePath: "/repo/.pkt-worktrees/conv-1",
    branch: "pkt/conv-1",
  };

  it("escalates the button label with the risk", () => {
    expect(worktreeDeleteConfirmLabel(null)).toBe("Delete");
    expect(worktreeDeleteConfirmLabel({ ...base, dirty: false, dirtyUnknown: false })).toBe(
      "Delete and discard worktree",
    );
    expect(worktreeDeleteConfirmLabel({ ...base, dirty: true, dirtyUnknown: false })).toBe(
      "Delete and discard changes",
    );
    expect(worktreeDeleteConfirmLabel({ ...base, dirty: false, dirtyUnknown: true })).toBe(
      "Delete and discard changes",
    );
  });
});
