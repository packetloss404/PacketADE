import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * FAULT under test: `sendIssueToWorkspace` provisions a per-Issue git worktree
 * so the `prepare-commit-msg` hook can append `Fixes #N` — that hook IS the
 * auto-Done close loop. When provisioning failed, or when the ticket id had no
 * numeric suffix to build `Fixes #N` from, it fell back to the bare project
 * root with a console.warn and returned success. The card then painted
 * "→ Workspace" and the Issue flipped to in_progress, so every visible signal
 * said the handoff was complete while the half the user relies on was silently
 * not wired up. The reason now rides back on the return value.
 */

const createIssueWorktree = vi.hoisted(() => vi.fn());
const createWorkspace = vi.hoisted(() => vi.fn(() => "ws-1"));
const setActiveWorkspace = vi.hoisted(() => vi.fn());
const setActiveView = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => {
    throw new Error("not in tauri");
  }),
}));

vi.mock("@/lib/tauri", () => ({
  createIssueWorktree: (...args: unknown[]) => createIssueWorktree(...args),
  saveIssuesSlice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({
      flights: [],
      reconcileIssueLinks: vi.fn(),
      removeIssueFromFlight: vi.fn(),
    }),
  },
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ projectPath: "D:/projects/example" }) },
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: { getState: () => ({ setActiveView }) },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspaces: [{ id: "ws-1", activeWorkspaceId: null, panes: [{ id: "pane-1" }] }],
      activeWorkspaceId: null,
      createWorkspace,
      setActiveWorkspace,
    }),
  },
}));

import { useIssueStore, type IssueStatus } from "@/stores/issueStore";

function seedIssue(ticketId: string) {
  useIssueStore.setState({
    issues: [
      {
        id: "issue-1",
        ticketId,
        title: "Fix the thing",
        description: "details",
        status: "todo" as IssueStatus,
        priority: "medium",
        labels: [],
        epic: null,
        acceptanceCriteria: [],
        blockedBy: [],
        blocks: [],
        createdAt: 0,
        updatedAt: 0,
      },
    ] as never,
  });
}

describe("sendIssueToWorkspace — auto-Done close loop honesty", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    createWorkspace.mockReturnValue("ws-1");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns no warning when the per-Issue worktree is provisioned", async () => {
    createIssueWorktree.mockResolvedValue("D:/projects/example/.worktrees/PKT-7");
    seedIssue("PKT-7");

    const result = await useIssueStore.getState().sendIssueToWorkspace("issue-1");

    expect(result?.workspaceId).toBe("ws-1");
    expect(result?.warning).toBeUndefined();
    // The pane must run INSIDE the worktree — that is where the hook lives.
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      "D:/projects/example/.worktrees/PKT-7",
      expect.anything(),
    );
  });

  it("warns that auto-Done will not fire when worktree provisioning throws", async () => {
    createIssueWorktree.mockRejectedValue(new Error("uncommitted changes in main"));
    seedIssue("PKT-7");

    const result = await useIssueStore.getState().sendIssueToWorkspace("issue-1");

    // The workspace still opens — a working pane beats no pane.
    expect(result?.workspaceId).toBe("ws-1");
    expect(createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      "D:/projects/example",
      expect.anything(),
    );
    expect(result?.warning).toContain("PKT-7");
    expect(result?.warning).toContain("not close the Issue automatically");
    // The underlying git reason has to survive to the user.
    expect(result?.warning).toContain("uncommitted changes in main");
  });

  it("warns when the ticket id has no numeric suffix to build `Fixes #N` from", async () => {
    seedIssue("RELEASE-CANDIDATE");

    const result = await useIssueStore.getState().sendIssueToWorkspace("issue-1");

    // No worktree is even attempted — there is no issue number for the hook.
    expect(createIssueWorktree).not.toHaveBeenCalled();
    expect(result?.workspaceId).toBe("ws-1");
    expect(result?.warning).toContain("no numeric ticket number");
    expect(result?.warning).toContain("not close the Issue automatically");
  });
});
