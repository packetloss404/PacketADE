import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/types/workspace";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const createPtySessionMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const loadConversationsMock = vi.fn();
const saveWorkspacesSliceMock = vi.fn();
const detachConversationsFromWorkspaceMock = vi.fn();
const retryLastTurnMock = vi.fn();
const saveAgentsSliceMock = vi.fn();

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
  createPtySession: (...args: unknown[]) => createPtySessionMock(...args),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([{ id: "pty-session-1", alive: true }]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: (...args: unknown[]) => saveAgentsSliceMock(...args),
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
  retryLastTurn: (...args: unknown[]) => retryLastTurnMock(...args),
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
    createPtySessionMock.mockResolvedValue("pty-session-1");
    startApiAgentSessionMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    saveWorkspacesSliceMock.mockResolvedValue(undefined);
    retryLastTurnMock.mockResolvedValue(undefined);
    saveAgentsSliceMock.mockResolvedValue(undefined);
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
      null,
      "auto",
      false,
      null,
    );
  });

  it("builds resume history from persisted project conversations without workspace metadata", async () => {
    const { buildConversationResumeMessages } = await import("@/stores/agentTaskStore");

    const resumeMessages = buildConversationResumeMessages([
      {
        id: "m1",
        role: "user",
        content: "Investigate the Agents pane",
        timestamp: 1,
      },
      {
        id: "m2",
        role: "assistant",
        content: "I found the provider dropdown.",
        timestamp: 2,
        toolCalls: [
          {
            id: "tool-1",
            name: "read_file",
            status: "done",
            fullContent: "src/components/agents/AgentSidebar.tsx",
          },
        ],
      },
      {
        id: "m3",
        role: "assistant",
        content: "still streaming",
        timestamp: 3,
        isStreaming: true,
      },
    ]);

    expect(resumeMessages).toEqual([
      { role: "user", content: "Investigate the Agents pane" },
      {
        role: "assistant",
        content:
          "I found the provider dropdown.\n\nTool calls:\n- read_file (done)\n  result: src/components/agents/AgentSidebar.tsx",
      },
    ]);
  });

  it("does not auto-failover when the Agents setting is disabled", async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation((eventName: string, callback: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => {});
    });

    const { useAgentSettingsStore } = await import("@/stores/agentSettingsStore");
    useAgentSettingsStore.getState().setAutoFailoverEnabled(false);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    await useAgentTaskStore
      .getState()
      .createApiConversation(
        "api-openai",
        "D:/projects/example",
        "gpt-4o",
        "Build the thing",
        undefined,
        false,
        false,
        null,
        "conv-no-failover",
        true,
      );

    listeners.get("api-agent:error:conv-no-failover")?.({
      payload: { message: "429 rate limit exceeded" },
    });

    expect(retryLastTurnMock).not.toHaveBeenCalled();
    expect(
      useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-no-failover")?.status,
    ).toBe("failed");
  });

  it("keeps auto-failover enabled by default", async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation((eventName: string, callback: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => {});
    });

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    await useAgentTaskStore
      .getState()
      .createApiConversation(
        "api-openai",
        "D:/projects/example",
        "gpt-4o",
        "Build the thing",
        undefined,
        false,
        false,
        null,
        "conv-failover",
        true,
      );

    listeners.get("api-agent:error:conv-failover")?.({
      payload: { message: "429 rate limit exceeded" },
    });

    expect(retryLastTurnMock).toHaveBeenCalledWith("conv-failover", "o4-mini");
  });

  it("uses CLI agent command overrides and default args for PTY task launches", async () => {
    const { useAgentStore } = await import("@/stores/agentStore");
    useAgentStore.getState().updateAgent("codex", {
      command: "C:\\tools\\codex-wrapper.cmd",
      defaultArgs: ["--model", "gpt-5.2"],
      installed: true,
    });

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    await useAgentTaskStore
      .getState()
      .launchTask("Build", "Do the thing", "codex", "D:/projects/example");

    expect(createPtySessionMock).toHaveBeenCalledWith(
      "D:/projects/example",
      120,
      40,
      "C:\\tools\\codex-wrapper.cmd",
      ["--full-auto", "--model", "gpt-5.2"],
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
