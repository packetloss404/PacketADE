import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCreationModal } from "@/components/workspace/WorkspaceCreationModal";
import { WorkspaceView } from "@/components/views/WorkspaceView";
import type { Workspace } from "@/types/workspace";

// Phase 3.1: the modal probes the remote path via Tauri before allowing
// Save. Mock the probe so the test doesn't need a real SSH backend.
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    sshCheckRemotePath: vi.fn().mockResolvedValue({
      exists: true,
      isDirectory: true,
      isGitRepo: false,
    }),
  };
});

const mocks = vi.hoisted(() => {
  const remoteWorkspace: Workspace = {
    id: "ws-remote",
    name: "Remote",
    agents: ["terminal"],
    panes: [
      {
        id: "pane-terminal",
        agentId: "terminal",
        sessionId: null,
      },
    ],
    projectPath: "/srv/app",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    serverId: "srv-1",
    remoteProjectPath: "/srv/app",
  };

  return {
    appState: {
      initialized: true,
      setActiveView: vi.fn(),
    },
    layoutState: {
      projectPath: "D:\\projects\\PacketADE",
    },
    workspaceState: {
      workspaces: [remoteWorkspace],
      activeWorkspaceId: "ws-remote",
      setActiveWorkspace: vi.fn(),
      createWorkspace: vi.fn(() => "ws-new"),
      addPane: vi.fn(() => "pane-new"),
      setBypassPermissions: vi.fn(),
    },
    agentState: {
      agents: [
        { id: "claude-code", installed: true },
        { id: "codex", installed: true },
        { id: "gemini", installed: true },
        { id: "opencode", installed: true },
      ],
      detecting: false,
    },
    serverState: {
      servers: [
        {
          id: "srv-1",
          name: "Remote",
          host: "example.com",
          port: 22,
          username: "ian",
          authMethod: "agent",
          remotePath: "/srv/app",
          installedAgents: ["claude-code"],
          // Phase 3.1: the workspace creation modal blocks Save when the
          // selected server has no pinned host fingerprint. Provide one
          // so the existing remote-template assertion still passes.
          hostFingerprint: "SHA256:example-fingerprint-for-test",
        },
      ],
    },
  };
});

vi.mock("@/stores/workspaceStore", () => {
  const useWorkspaceStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.workspaceState) => unknown) =>
      selector(mocks.workspaceState),
    ),
    {
      getState: vi.fn(() => mocks.workspaceState),
    },
  );
  return { useWorkspaceStore };
});

vi.mock("@/stores/appStore", () => ({
  useAppStore: Object.assign(
    vi.fn((selector: (state: typeof mocks.appState) => unknown) =>
      selector(mocks.appState),
    ),
    {
      getState: vi.fn(() => mocks.appState),
    },
  ),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn((selector: (state: typeof mocks.layoutState) => unknown) =>
    selector(mocks.layoutState),
  ),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: vi.fn((selector: (state: typeof mocks.agentState) => unknown) =>
    selector(mocks.agentState),
  ),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: vi.fn((selector: (state: typeof mocks.serverState) => unknown) =>
    selector(mocks.serverState),
  ),
}));

vi.mock("@/stores/promptStore", () => ({
  usePromptStore: vi.fn((selector: (state: { templates: unknown[] }) => unknown) =>
    selector({ templates: [] }),
  ),
}));

vi.mock("@/stores/editorStore", () => ({
  useEditorStore: vi.fn(
    (selector: (state: {
      openFiles: unknown[];
      activeFileId: null;
      closeFile: () => void;
      setActiveFile: () => void;
    }) => unknown) =>
      selector({
        openFiles: [],
        activeFileId: null,
        closeFile: vi.fn(),
        setActiveFile: vi.fn(),
      }),
  ),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: vi.fn(
    (selector: (state: { patterns: unknown[]; isLearning: boolean }) => unknown) =>
      selector({ patterns: [], isLearning: false }),
  ),
}));

vi.mock("@/lib/onboarding", () => ({
  isOnboardingComplete: () => true,
}));

vi.mock("@/components/workspace/WorkspaceMosaicContainer", () => ({
  WorkspaceMosaicContainer: () => <div data-testid="workspace-mosaic" />,
}));

vi.mock("@/components/onboarding/OnboardingPane", () => ({
  OnboardingPane: () => <div />,
}));

vi.mock("@/components/editor/EditorPane", () => ({
  EditorPane: () => <div />,
}));

vi.mock("@/components/workspace/GitDashboard", () => ({
  GitDashboard: () => <div />,
}));

describe("workspace launch installed-agent checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters remote workspace templates through server installedAgents", async () => {
    render(
      <WorkspaceCreationModal
        onClose={vi.fn()}
        serverId="srv-1"
        remoteProjectPath="/srv/app"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /duo/i }));

    // The new Location step debounces an SSH probe before enabling Save.
    // Wait for the button to become enabled before clicking it.
    const saveBtn = screen.getByRole("button", { name: "Create Workspace" });
    await waitFor(() => expect(saveBtn).not.toBeDisabled(), { timeout: 2000 });
    fireEvent.click(saveBtn);

    expect(mocks.workspaceState.createWorkspace).toHaveBeenCalledWith(
      "Duo",
      ["claude-code"],
      "/srv/app",
      expect.objectContaining({
        serverId: "srv-1",
        remoteProjectPath: "/srv/app",
      }),
    );
  });

  it("disables Add Agent rows that are unavailable on the active remote server", () => {
    render(<WorkspaceView />);

    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));

    expect(screen.getByRole("button", { name: "Codex" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    expect(mocks.workspaceState.addPane).toHaveBeenCalledWith("ws-remote", "claude-code");
    expect(mocks.workspaceState.addPane).not.toHaveBeenCalledWith("ws-remote", "codex");
  });
});
