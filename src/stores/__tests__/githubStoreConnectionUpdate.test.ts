// `updateGitHostConnection` — rotate a token / rename a host in place.
//
// The store's job here is narrow but load-bearing: forward the edit, never
// keep the credential, refresh what the UI reads, and let a refusal through to
// the caller instead of making a failed rotation look successful.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateConnection: vi.fn().mockResolvedValue(undefined),
  listConnections: vi.fn().mockResolvedValue([]),
  hasToken: vi.fn().mockResolvedValue(true),
  getUser: vi.fn().mockResolvedValue({ login: "rotated-user", avatarUrl: "" }),
  setActive: vi.fn().mockResolvedValue(undefined),
  save: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  gitHostUpdateConnection: (...args: unknown[]) => mocks.updateConnection(...args),
  gitHostListConnections: (...args: unknown[]) => mocks.listConnections(...args),
  gitHostHasToken: (...args: unknown[]) => mocks.hasToken(...args),
  githubGetAuthenticatedUser: (...args: unknown[]) => mocks.getUser(...args),
  gitHostSetActive: (...args: unknown[]) => mocks.setActive(...args),
  githubSetToken: vi.fn(),
  githubClearToken: vi.fn(),
  gitHostRemoveConnection: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  loadFromStorage: vi.fn((_key: string, fallback: unknown) => fallback),
  saveToStorage: (...args: unknown[]) => mocks.save(...args),
}));

vi.mock("@/lib/gitHostResolve", () => ({
  resolveConnectionForRemote: vi.fn(() => ({ connectionId: null })),
}));

import { useGitHubStore } from "@/stores/githubStore";

const SECRET = "glpat_CANARY_must_never_leak_0000";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateConnection.mockResolvedValue(undefined);
  mocks.listConnections.mockResolvedValue([
    {
      id: "gitlab-1",
      kind: "gitlab",
      baseUrl: "https://gitlab.com",
      label: "Renamed",
      hasToken: true,
    },
  ]);
  useGitHubStore.setState({
    activeConnectionId: "github",
    connections: [],
    isInitializing: false,
  } as never);
});

describe("githubStore.updateGitHostConnection", () => {
  it("forwards the edit and refreshes the connection list", async () => {
    await useGitHubStore.getState().updateGitHostConnection("gitlab-1", {
      label: "Renamed",
      token: SECRET,
      kind: "gitlab",
      baseUrl: "https://gitlab.com",
    });

    expect(mocks.updateConnection).toHaveBeenCalledWith("gitlab-1", {
      label: "Renamed",
      token: SECRET,
      kind: "gitlab",
      baseUrl: "https://gitlab.com",
    });
    expect(mocks.listConnections).toHaveBeenCalled();
    expect(useGitHubStore.getState().connections[0].label).toBe("Renamed");
  });

  it("never retains the credential in store state", async () => {
    await useGitHubStore.getState().updateGitHostConnection("gitlab-1", { token: SECRET });
    expect(JSON.stringify(useGitHubStore.getState())).not.toContain(SECRET);
    // ...nor in anything written to localStorage.
    for (const call of mocks.save.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
  });

  it("re-probes identity when the ACTIVE connection's token was rotated", async () => {
    useGitHubStore.setState({ activeConnectionId: "gitlab-1" } as never);
    await useGitHubStore.getState().updateGitHostConnection("gitlab-1", { token: SECRET });
    // The cached user belongs to the old token; it has to be re-resolved.
    expect(mocks.getUser).toHaveBeenCalled();
  });

  it("does not re-probe for a rename, or for an inactive connection", async () => {
    useGitHubStore.setState({ activeConnectionId: "gitlab-1" } as never);
    await useGitHubStore.getState().updateGitHostConnection("gitlab-1", { label: "Renamed" });
    expect(mocks.getUser).not.toHaveBeenCalled();

    useGitHubStore.setState({ activeConnectionId: "github" } as never);
    await useGitHubStore.getState().updateGitHostConnection("gitlab-1", { token: SECRET });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("propagates a refusal rather than reporting success", async () => {
    mocks.updateConnection.mockRejectedValue(
      new Error(
        "The new token was not saved because the host rejected it. The existing credential is unchanged.",
      ),
    );
    await expect(
      useGitHubStore.getState().updateGitHostConnection("gitlab-1", { token: SECRET }),
    ).rejects.toThrow(/existing credential is unchanged/);
    // A refused rotation must not look like a successful one.
    expect(mocks.listConnections).not.toHaveBeenCalled();
  });
});
