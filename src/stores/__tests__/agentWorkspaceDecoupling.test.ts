import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types/workspace";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const loadConversationsMock = vi.fn();
const saveWorkspacesSliceMock = vi.fn();
const detachConversationsFromWorkspaceMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({
      getContextForSession: vi.fn(() => ""),
    })),
  },
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({
      setProjectPath: vi.fn(),
    })),
  },
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn(),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn(),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  saveCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: (...args: unknown[]) => saveWorkspacesSliceMock(...args),
}));

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: "workspace-1",
    name: "Workspace 1",
    agents: ["codex"],
    panes: [
      {
        id: "pane-1",
        agentId: "codex",
        sessionId: "session-1",
        accentColor: "accent-green",
      },
    ],
    projectPath: "D:/projects/example",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

describe("agent/workspace store decoupling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    saveWorkspacesSliceMock.mockResolvedValue(undefined);
  });

  it("does not write workspaceId on newly-created API conversations", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    const id = await useAgentTaskStore
      .getState()
      .createApiConversation("api-openai", "D:/projects/example", "gpt-4.1", "Build the thing");

    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);

    expect(conversation).toBeDefined();
    expect(conversation).not.toHaveProperty("workspaceId");
    expect(startApiAgentSessionMock).toHaveBeenCalledWith(
      id,
      "openai",
      "gpt-4.1",
      "D:/projects/example",
      "Build the thing",
      null,
      false,
      undefined,
      false,
      null,
      null,
      null,
      null,
    );
  });

  it("archives and deletes workspaces without calling agent conversation detach", async () => {
    vi.doMock("@/stores/agentTaskStore", () => ({
      useAgentTaskStore: {
        getState: vi.fn(() => ({
          detachConversationsFromWorkspace: detachConversationsFromWorkspaceMock,
        })),
      },
    }));

    const { useWorkspaceStore } = await import("@/stores/workspaceStore");
    const workspace = makeWorkspace();

    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      keepTerminalsAlive: false,
      zoomedPaneId: null,
    });

    useWorkspaceStore.getState().archiveWorkspace(workspace.id);

    expect(detachConversationsFromWorkspaceMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces[0]).toMatchObject({
      id: workspace.id,
      status: "archived",
    });

    useWorkspaceStore.setState({
      workspaces: [{ ...workspace, status: "active" }],
      activeWorkspaceId: workspace.id,
    });

    useWorkspaceStore.getState().deleteWorkspace(workspace.id);

    expect(detachConversationsFromWorkspaceMock).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
  });
});
