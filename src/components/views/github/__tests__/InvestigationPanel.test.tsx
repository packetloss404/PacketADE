import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssue } from "@/types/github";

// Stub the heavy markdown renderer so the test stays focused on the CTA
// surface; the renderer pulls in react-markdown + remark-gfm and we don't
// need to round-trip the markdown to verify panel behavior.
vi.mock("@/components/common/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

// Hoisted mock state — these are mutated per-test via the helpers below.
// The `createWorkspace` mock is typed against the store's call signature
// (name, agents, projectPath, sessionConfig?) so `mock.calls[0]` indexes
// into a typed 4-tuple instead of `[]`.
type CreateWorkspaceMock = (
  name: string,
  agents: unknown[],
  projectPath: string,
  sessionConfig?: { prompt?: string },
) => string;

const mocks = vi.hoisted(() => {
  type WorkspaceFixture = {
    id: string;
    name: string;
    agents: string[];
    panes: unknown[];
    projectPath: string;
    createdAt: number;
    updatedAt: number;
    status: string;
  };
  return {
    appState: {
      setActiveView: vi.fn(),
    },
    layoutState: {
      projectPath: "D:\\projects\\PacketBench" as string,
    },
    workspaceState: {
      workspaces: [
        {
          id: "ws-1",
          name: "Active Workspace",
          agents: ["claude-code"],
          panes: [],
          projectPath: "D:\\projects\\PacketBench",
          createdAt: 1,
          updatedAt: 1,
          status: "active",
        },
      ] as WorkspaceFixture[],
      activeWorkspaceId: "ws-1" as string | null,
      createWorkspace: vi.fn<CreateWorkspaceMock>(() => "ws-new"),
      setActiveWorkspace: vi.fn(),
    },
    flightState: {
      addFlight: vi.fn((input: { title: string }) => ({
        id: "flight-new",
        ...input,
      })),
      setActiveFlight: vi.fn(),
    },
    asyncFlightState: {
      launchAsync: vi.fn().mockResolvedValue([]),
    },
    memoryState: {
      captureManually: vi.fn(() => ({ id: "mem-new" })),
    },
  };
});

vi.mock("@/stores/appStore", () => ({
  useAppStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.appState) => unknown) =>
      selector(mocks.appState),
    ),
    { getState: vi.fn(() => mocks.appState) },
  ),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn(
    (selector: (state: typeof mocks.layoutState) => unknown) =>
      selector(mocks.layoutState),
  ),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.workspaceState) => unknown) =>
      selector(mocks.workspaceState),
    ),
    { getState: vi.fn(() => mocks.workspaceState) },
  ),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.flightState) => unknown) =>
      selector(mocks.flightState),
    ),
    { getState: vi.fn(() => mocks.flightState) },
  ),
}));

vi.mock("@/stores/asyncFlightStore", () => ({
  useAsyncFlightStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.asyncFlightState) => unknown) =>
      selector(mocks.asyncFlightState),
    ),
    { getState: vi.fn(() => mocks.asyncFlightState) },
  ),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.memoryState) => unknown) =>
      selector(mocks.memoryState),
    ),
    { getState: vi.fn(() => mocks.memoryState) },
  ),
}));

import { InvestigationPanel } from "@/components/views/github/InvestigationPanel";

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: "Crash on launch",
    body: "Repro: open app, observe crash.",
    state: "open",
    labels: [],
    user: { login: "octocat" },
    html_url: "https://example.com/issues/42",
    created_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

describe("InvestigationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default project path / active workspace each test.
    mocks.layoutState.projectPath = "D:\\projects\\PacketBench";
    mocks.workspaceState.activeWorkspaceId = "ws-1";
    mocks.workspaceState.workspaces = [
      {
        id: "ws-1",
        name: "Active Workspace",
        agents: ["claude-code"],
        panes: [],
        projectPath: "D:\\projects\\PacketBench",
        createdAt: 1,
        updatedAt: 1,
        status: "active",
      },
    ];
    mocks.workspaceState.createWorkspace.mockReturnValue("ws-new");
  });

  it('Hand off to Claude creates a workspace and routes to "workspace" view', async () => {
    render(
      <InvestigationPanel
        issue={makeIssue()}
        investigation="The bug is in foo.ts:42 — null deref."
        isInvestigating={false}
        onRun={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Hand off to Claude/i }));

    await waitFor(() => {
      expect(mocks.workspaceState.createWorkspace).toHaveBeenCalledTimes(1);
    });

    const call = mocks.workspaceState.createWorkspace.mock.calls[0];
    // signature: (name, agents, projectPath, sessionConfig)
    expect(call[0]).toContain("GH #42");
    expect(call[1]).toEqual(["claude-code"]);
    expect(call[2]).toBe("D:\\projects\\PacketBench");
    expect(call[3]).toMatchObject({ prompt: expect.stringContaining("#42") });

    expect(mocks.workspaceState.setActiveWorkspace).toHaveBeenCalledWith("ws-new");
    expect(mocks.appState.setActiveView).toHaveBeenCalledWith("workspace");

    expect(
      await screen.findByText(/Opened Claude with #42 context/i),
    ).toBeInTheDocument();
  });

  it("Save as memory calls captureManually with the issue context payload", async () => {
    render(
      <InvestigationPanel
        issue={makeIssue({ number: 7, title: "Tiny bug" })}
        investigation="Investigation body content"
        isInvestigating={false}
        onRun={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Save as memory/i }));

    await waitFor(() => {
      expect(mocks.memoryState.captureManually).toHaveBeenCalledTimes(1);
    });

    expect(mocks.memoryState.captureManually).toHaveBeenCalledWith({
      // A plain path is still a valid scope input — the GitHub pane always
      // works against a checked-out local repo.
      scope: "D:\\projects\\PacketBench",
      source: "github-investigation",
      summary: "Investigation for #7: Tiny bug",
      body: "Investigation body content",
      tags: ["github-investigation", "gh-7"],
    });

    expect(
      await screen.findByText(/Saved to project memory/i),
    ).toBeInTheDocument();
  });

  it('Draft patch shows an error feedback when no project path is available', async () => {
    // No active workspace + empty layout path → resolvedProjectPath = "".
    mocks.workspaceState.activeWorkspaceId = null;
    mocks.workspaceState.workspaces = [];
    mocks.layoutState.projectPath = "";

    render(
      <InvestigationPanel
        issue={makeIssue()}
        investigation="Some investigation result"
        isInvestigating={false}
        onRun={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Draft patch/i }));

    expect(
      await screen.findByText(/No active workspace — open one to draft a patch/i),
    ).toBeInTheDocument();

    // Critically: no flight should have been created and no async launch
    // should have been kicked off.
    expect(mocks.flightState.addFlight).not.toHaveBeenCalled();
    expect(mocks.asyncFlightState.launchAsync).not.toHaveBeenCalled();
  });

  it("clears the feedback strip when the investigation prop changes", async () => {
    const issue = makeIssue({ number: 100 });
    const { rerender } = render(
      <InvestigationPanel
        issue={issue}
        investigation="First investigation"
        isInvestigating={false}
        onRun={vi.fn()}
      />,
    );

    // Surface a feedback message via Save as memory (the simplest CTA —
    // it doesn't depend on a project path).
    fireEvent.click(screen.getByRole("button", { name: /Save as memory/i }));
    expect(
      await screen.findByText(/Saved to project memory/i),
    ).toBeInTheDocument();

    // When the investigation prop flips, the effect should reset feedback.
    act(() => {
      rerender(
        <InvestigationPanel
          issue={issue}
          investigation="Second, different investigation"
          isInvestigating={false}
          onRun={vi.fn()}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/Saved to project memory/i)).toBeNull();
    });
  });
});
