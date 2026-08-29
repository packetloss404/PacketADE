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
    loadConnections: vi.fn().mockResolvedValue(undefined),
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

  it("opens the wizard pre-selected for a self-hosted host from 'Add host'", () => {
    render(<GitHubSettingsCard />);
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    expect(screen.getByTestId("wizard")).toHaveTextContent("wizard:gitea");
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
