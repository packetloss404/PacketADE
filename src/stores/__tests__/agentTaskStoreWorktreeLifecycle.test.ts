import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const loadConversationsMock = vi.fn();
const getGitStatusMock = vi.fn();
const removeConversationWorktreeMock = vi.fn();
const saveConversationMock = vi.fn();

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
    getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "") })),
  },
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({ setProjectPath: vi.fn() })),
  },
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn(),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn(),
  saveConversation: (...args: unknown[]) => saveConversationMock(...args),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  getGitStatus: (...args: unknown[]) => getGitStatusMock(...args),
  removeConversationWorktree: (...args: unknown[]) => removeConversationWorktreeMock(...args),
}));

const CONV_ID = "conv-wt";

function seedWorktreeConversation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: CONV_ID,
    title: "Worktree conversation",
    agent: "api-openai",
    projectPath: "/repo/.pkt-worktrees/conv-wt",
    status: "idle",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    archived: false,
    worktree: {
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-wt",
      branch: "pkt/conv-wt",
      baseBranch: "main",
      createdAt: now,
      state: "active",
    },
    ...overrides,
  };
}

describe("agentTaskStore — worktree lifecycle plumbing (P2-S2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    saveConversationMock.mockResolvedValue(undefined);
    getGitStatusMock.mockResolvedValue(""); // clean by default
    removeConversationWorktreeMock.mockResolvedValue(undefined);
  });

  it("setConversationWorktreeState flips the lifecycle state and persists", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedWorktreeConversation()] } as never);

    useAgentTaskStore.getState().setConversationWorktreeState(CONV_ID, "landed");

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.state).toBe("landed");
    expect(saveConversationMock).not.toHaveBeenCalled(); // debounced
    await vi.waitFor(() => {
      expect(saveConversationMock).toHaveBeenCalled();
      const [id, json] = saveConversationMock.mock.calls[saveConversationMock.mock.calls.length - 1];
      expect(id).toBe(CONV_ID);
      expect(JSON.parse(json as string).worktree.state).toBe("landed");
    });
  });

  it("recordConversationPr stores the PR number on the worktree, persisted through the snapshot", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedWorktreeConversation()] } as never);

    useAgentTaskStore.getState().recordConversationPr(CONV_ID, 77);

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.prNumber).toBe(77);
    await vi.waitFor(() => {
      const [, json] = saveConversationMock.mock.calls[saveConversationMock.mock.calls.length - 1];
      expect(JSON.parse(json as string).worktree.prNumber).toBe(77);
    });
  });

  it("discardConversationWorktree on a CLEAN tree removes dir + branch and flips state → discarded", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedWorktreeConversation()] } as never);

    await useAgentTaskStore.getState().discardConversationWorktree(CONV_ID);

    // deleteBranch flag is true — dir AND pkt/<id> branch removed.
    expect(removeConversationWorktreeMock).toHaveBeenCalledWith("/repo", CONV_ID, true);
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.state).toBe("discarded");
  });

  it("discardConversationWorktree on a DIRTY tree without confirm rejects and removes nothing", async () => {
    getGitStatusMock.mockResolvedValue(" M src/foo.ts\n?? new.txt\n");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedWorktreeConversation()] } as never);

    await expect(
      useAgentTaskStore.getState().discardConversationWorktree(CONV_ID),
    ).rejects.toThrow(/uncommitted changes/i);

    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.state).toBe("active"); // untouched
  });

  it("discardConversationWorktree on a DIRTY tree WITH confirm removes dir + branch and discards", async () => {
    getGitStatusMock.mockResolvedValue(" M src/foo.ts\n");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [seedWorktreeConversation()] } as never);

    await useAgentTaskStore
      .getState()
      .discardConversationWorktree(CONV_ID, { confirmed: true });

    expect(removeConversationWorktreeMock).toHaveBeenCalledWith("/repo", CONV_ID, true);
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === CONV_ID);
    expect(conv?.worktree?.state).toBe("discarded");
  });

  it("discardConversationWorktree is a no-op for a conversation that ran in the project root", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        seedWorktreeConversation({ id: "root-conv", projectPath: "/repo", worktree: undefined }),
      ],
    } as never);

    await useAgentTaskStore.getState().discardConversationWorktree("root-conv");

    expect(getGitStatusMock).not.toHaveBeenCalled();
    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
  });

  it("discardConversationWorktree skips SSH conversations (remote worktree)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        seedWorktreeConversation({
          id: "ssh-conv",
          sshTarget: { serverId: "s1", name: "host", host: "h", port: 22, user: "u", remotePath: "/r", keyPath: null, authMethod: "key", hostFingerprint: null },
        }),
      ],
    } as never);

    await useAgentTaskStore.getState().discardConversationWorktree("ssh-conv");

    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
  });
});
