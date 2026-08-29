// Entry points for the guided git-host setup wizard.
//
// The card is the place users go when they want to connect a host, so both of
// its "connect something" affordances must reach the wizard — and the
// self-hosted one must land on the right host without the user re-picking it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
}));

vi.mock("@/lib/tauri", () => ({
  githubDeviceFlowStart: vi.fn(),
  githubDeviceFlowPoll: vi.fn(),
  githubOauthConfigured: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/components/gitHost/GitHostSetupWizard", () => ({
  GitHostSetupWizard: ({ initialDescriptorId }: { initialDescriptorId?: string }) => (
    <div data-testid="wizard">wizard:{initialDescriptorId}</div>
  ),
}));

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.storeState),
}));

import { GitHubSettingsCard } from "@/components/views/tools/GitHubSettingsCard";

beforeEach(() => {
  mocks.storeState = {
    isConnected: false,
    authenticatedUser: null,
    isLoading: false,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearError: vi.fn(),
    defaultMergeStrategy: "squash",
    requireMergeConfirmation: true,
    defaultDraftPrs: false,
    defaultPublishAttemptsAsPrs: false,
    setDefaultMergeStrategy: vi.fn(),
    setRequireMergeConfirmation: vi.fn(),
    setDefaultDraftPrs: vi.fn(),
    setDefaultPublishAttemptsAsPrs: vi.fn(),
    connections: [],
    activeConnectionId: "github",
    loadConnections: vi.fn().mockResolvedValue(undefined),
    setActiveConnection: vi.fn(),
    removeGitHostConnection: vi.fn(),
    initializeAuth: vi.fn(),
  };
});

describe("Git Hosts settings card → setup wizard", () => {
  it("offers a guided path from the not-connected state", () => {
    render(<GitHubSettingsCard />);
    expect(screen.queryByTestId("wizard")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Guided setup/i }));
    expect(screen.getByTestId("wizard")).toHaveTextContent("wizard:github");
  });

  it("opens 'Add host' on the wizard's host picker, not pre-pinned to Gitea", () => {
    // FAULT: this used to pass `initialDescriptorId="gitea"`, which skipped
    // step 1 entirely. Once GitLab and GitHub Enterprise joined the wizard,
    // that made Gitea the ONLY host reachable from this card — the picker the
    // user needed to see was the step being jumped over. With no descriptor
    // the wizard starts on "Choose a host".
    render(<GitHubSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    expect(screen.getByTestId("wizard")).toHaveTextContent("wizard:");
    expect(screen.getByTestId("wizard")).not.toHaveTextContent("wizard:gitea");
  });

  it("no longer exposes a bare paste-a-token form for self-hosted hosts", () => {
    render(<GitHubSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    // The old inline form asked for a URL + token with no validation; the
    // wizard replaces it entirely.
    expect(screen.queryByPlaceholderText("https://git.example.com")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Access token")).not.toBeInTheDocument();
  });
});

/**
 * FAULT: the connection list filtered on `kind === "gitea"`. A GitLab
 * connection — addable through this card's own wizard — was therefore
 * invisible here, and Remove is a per-row button, so its keyring token had no
 * reachable control at all. These pin the general rule: everything that is not
 * the built-in GitHub singleton is listed and removable.
 */
describe("Git Hosts settings card → connection list", () => {
  const GITLAB = {
    id: "gitlab-1",
    kind: "gitlab" as const,
    baseUrl: "https://gitlab.com",
    label: "gitlab.com",
    hasToken: true,
  };
  const GITEA = {
    id: "gitea-1",
    kind: "gitea" as const,
    baseUrl: "https://git.example.com",
    label: "internal",
    hasToken: true,
  };
  const GITHUB = {
    id: "github",
    kind: "github" as const,
    baseUrl: "https://api.github.com",
    label: "GitHub",
    hasToken: true,
  };

  it("lists a GitLab connection alongside Gitea, labelled as GitLab", () => {
    mocks.storeState.connections = [GITHUB, GITLAB, GITEA];
    render(<GitHubSettingsCard />);
    expect(screen.getByText("gitlab.com")).toBeInTheDocument();
    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.getByText("internal")).toBeInTheDocument();
  });

  it("offers Remove for a GitLab connection", () => {
    mocks.storeState.connections = [GITHUB, GITLAB];
    render(<GitHubSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Remove gitlab.com" }));
    // Destructive path is behind the shared confirm, not the trash click.
    expect(mocks.storeState.removeGitHostConnection).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Remove git host?" })).toBeInTheDocument();
  });

  it("never offers to remove the built-in GitHub connection", () => {
    mocks.storeState.connections = [GITHUB];
    render(<GitHubSettingsCard />);
    // The backend rejects removing it; the UI must not offer the button.
    expect(screen.queryByRole("button", { name: "Remove GitHub" })).not.toBeInTheDocument();
  });

  it("can activate a non-active host, and marks the active one instead", () => {
    mocks.storeState.connections = [GITHUB, GITLAB, GITEA];
    mocks.storeState.activeConnectionId = "gitea-1";
    render(<GitHubSettingsCard />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use gitlab.com" }));
    expect(mocks.storeState.setActiveConnection).toHaveBeenCalledWith("gitlab-1");
  });
});
