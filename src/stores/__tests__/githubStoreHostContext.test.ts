import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setActive: vi.fn().mockResolvedValue(undefined),
  hasToken: vi.fn().mockResolvedValue(true),
  getUser: vi.fn().mockResolvedValue({ login: "host-user", avatarUrl: "" }),
  listIssuesPage: vi.fn(),
  getPrDiff: vi.fn(),
  investigateIssue: vi.fn(),
  postIssueComment: vi.fn(),
  setToken: vi.fn().mockResolvedValue(undefined),
  clearToken: vi.fn().mockResolvedValue(undefined),
  removeConnection: vi.fn().mockResolvedValue(undefined),
  listConnections: vi.fn().mockResolvedValue([]),
  save: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gitHostSetActive: (...args: unknown[]) => mocks.setActive(...args),
  gitHostHasToken: (...args: unknown[]) => mocks.hasToken(...args),
  githubGetAuthenticatedUser: (...args: unknown[]) => mocks.getUser(...args),
  githubListIssuesPage: (...args: unknown[]) => mocks.listIssuesPage(...args),
  githubGetPrDiff: (...args: unknown[]) => mocks.getPrDiff(...args),
  githubInvestigateIssue: (...args: unknown[]) => mocks.investigateIssue(...args),
  githubPostIssueComment: (...args: unknown[]) => mocks.postIssueComment(...args),
  githubSetToken: (...args: unknown[]) => mocks.setToken(...args),
  githubClearToken: (...args: unknown[]) => mocks.clearToken(...args),
  gitHostRemoveConnection: (...args: unknown[]) => mocks.removeConnection(...args),
  gitHostListConnections: (...args: unknown[]) => mocks.listConnections(...args),
}));

vi.mock("@/lib/storage", () => ({
  loadFromStorage: vi.fn((_key: string, fallback: unknown) => fallback),
  saveToStorage: (...args: unknown[]) => mocks.save(...args),
}));

vi.mock("@/lib/gitHostResolve", () => ({
  resolveConnectionForRemote: vi.fn(() => ({ connectionId: null })),
}));

import { useGitHubStore } from "@/stores/githubStore";

describe("githubStore host authority boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGitHubStore.setState({
      activeConnectionId: "github",
      config: { selectedRepo: { owner: "old", repo: "repo" } },
      repos: [{ id: 1, name: "repo", full_name: "old/repo", private: false }],
      issues: [{ number: 17, title: "old issue" }],
      prs: [{ number: 17, title: "old PR" }],
      prDiff: "old diff",
      investigation: "old investigation",
      notifications: [{ id: "old" }],
      unreadCount: 1,
      lastSyncAt: 123,
      isConnected: true,
      isInitializing: false,
    } as never);
  });

  it("clears repo-scoped data before changing Git hosts", async () => {
    useGitHubStore.getState().setActiveConnection("gitea:local");

    const state = useGitHubStore.getState();
    expect(state.activeConnectionId).toBe("gitea:local");
    expect(state.config.selectedRepo).toBeNull();
    expect(state.repos).toEqual([]);
    expect(state.issues).toEqual([]);
    expect(state.prs).toEqual([]);
    expect(state.prDiff).toBeNull();
    expect(state.investigation).toBeNull();
    expect(state.notifications).toEqual([]);
    expect(state.unreadCount).toBe(0);
    expect(state.lastSyncAt).toBeNull();
    await vi.waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith("gitea:local"));
    await vi.waitFor(() => expect(useGitHubStore.getState().isConnected).toBe(true));
  });

  it("does not discard the selected repo when the host is unchanged", () => {
    useGitHubStore.getState().setActiveConnection("github");

    expect(useGitHubStore.getState().config.selectedRepo).toEqual({
      owner: "old",
      repo: "repo",
    });
    expect(mocks.setActive).not.toHaveBeenCalled();
  });

  it("drops an old repository response after the Git host changes", async () => {
    let release!: (json: string) => void;
    mocks.listIssuesPage.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const pending = useGitHubStore.getState().fetchIssues();
    useGitHubStore.getState().setActiveConnection("gitea:local");
    release(JSON.stringify([{ number: 99, title: "stale issue" }]));
    await pending;
    await vi.waitFor(() => expect(useGitHubStore.getState().isInitializing).toBe(false));

    expect(useGitHubStore.getState().issues).toEqual([]);
    expect(useGitHubStore.getState().config.selectedRepo).toBeNull();
  });

  it("clears unkeyed detail state when changing repositories", () => {
    useGitHubStore.setState({
      releases: [{ id: 1, tagName: "old" }],
      prDiff: "old diff",
      investigation: "old investigation",
    } as never);

    useGitHubStore.getState().selectRepo("new", "repo");

    const state = useGitHubStore.getState();
    expect(state.releases).toEqual([]);
    expect(state.prDiff).toBeNull();
    expect(state.investigation).toBeNull();
  });

  it("serializes rapid host changes and leaves the latest host authoritative", async () => {
    useGitHubStore.getState().setActiveConnection("gitea:first");
    useGitHubStore.getState().setActiveConnection("github");

    await vi.waitFor(() => expect(mocks.setActive).toHaveBeenCalledTimes(2));
    expect(mocks.setActive.mock.calls.map((call) => call[0])).toEqual(["gitea:first", "github"]);
    await vi.waitFor(() => expect(useGitHubStore.getState().isInitializing).toBe(false));
    expect(useGitHubStore.getState().activeConnectionId).toBe("github");
    expect(mocks.hasToken).toHaveBeenLastCalledWith("github");
  });

  it("keeps only the latest selected PR diff", async () => {
    let releaseFirst!: (diff: string) => void;
    let releaseSecond!: (diff: string) => void;
    mocks.getPrDiff
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseSecond = resolve;
          }),
      );

    const first = useGitHubStore.getState().getPrDiff(1);
    const second = useGitHubStore.getState().getPrDiff(2);
    releaseSecond("diff for PR 2");
    await second;
    releaseFirst("diff for PR 1");
    await first;

    expect(useGitHubStore.getState().prDiff).toBe("diff for PR 2");
  });

  it("invalidates an issue investigation when selection is cleared", async () => {
    let release!: (result: string) => void;
    mocks.investigateIssue.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const pending = useGitHubStore.getState().investigateIssue("C:\\repo", 1);
    useGitHubStore.getState().clearInvestigation();
    release("stale investigation");
    await pending;

    expect(useGitHubStore.getState().investigation).toBeNull();
    expect(useGitHubStore.getState().isInvestigating).toBe(false);
  });

  it("does not append an old comment after repository authority changes", async () => {
    let release!: (comment: unknown) => void;
    mocks.postIssueComment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = useGitHubStore.getState().postIssueComment({ number: 17 }, "old comment");
    useGitHubStore.getState().selectRepo("new", "repo");
    release({ id: 1, body: "old comment" });
    await pending;

    expect(useGitHubStore.getState().issueComments).toEqual({});
  });

  it("does not report a rejected freshly entered token as connected", async () => {
    mocks.getUser.mockRejectedValueOnce(new Error("401 Bad credentials"));

    await useGitHubStore.getState().connect("revoked-token");

    expect(mocks.clearToken).toHaveBeenCalledTimes(1);
    expect(useGitHubStore.getState().isConnected).toBe(false);
    expect(useGitHubStore.getState().authenticatedUser).toBeNull();
    expect(useGitHubStore.getState().error).toContain("rejected this token");
  });

  it("does not reset current repo data when removing an unrelated host", async () => {
    await useGitHubStore.getState().removeGitHostConnection("gitea:unused");

    expect(useGitHubStore.getState().activeConnectionId).toBe("github");
    expect(useGitHubStore.getState().config.selectedRepo).toEqual({
      owner: "old",
      repo: "repo",
    });
    expect(useGitHubStore.getState().issues).toHaveLength(1);
    expect(mocks.setActive).not.toHaveBeenCalled();
  });
});
