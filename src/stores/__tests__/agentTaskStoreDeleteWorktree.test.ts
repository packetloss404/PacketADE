/**
 * Delete → worktree discard fan-out (owner decision 2026-07-30: "Discard,
 * surface the confirm").
 *
 * Deleting a conversation used to leave its worktree directory and `pkt/<id>`
 * branch behind forever — the record that named them was gone, so nothing in
 * the app could ever find them again. These tests pin the fan-out: the discard
 * happens, it force-deletes the branch, it never takes the delete down with it,
 * and it reports failures instead of swallowing them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const loadConversationsMock = vi.fn();
const getGitStatusMock = vi.fn();
const removeConversationWorktreeMock = vi.fn();
const deleteConversationFileMock = vi.fn();

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
    getState: vi.fn(() => ({})),
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
  killPty: vi.fn().mockResolvedValue(undefined),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: (...args: unknown[]) => deleteConversationFileMock(...args),
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

const CONV_ID = "conv-del";

function worktreeConversation(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: CONV_ID,
    title: "Worktree conversation",
    agent: "api-openai",
    projectPath: "/repo/.pkt-worktrees/conv-del",
    status: "done",
    messages: [],
    sessionId: null,
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    archived: false,
    worktree: {
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-del",
      branch: "pkt/conv-del",
      baseBranch: "main",
      createdAt: now,
      state: "active",
    },
    ...overrides,
  };
}

describe("agentTaskStore.deleteConversation — worktree discard fan-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    deleteConversationFileMock.mockResolvedValue(undefined);
    getGitStatusMock.mockResolvedValue("");
    removeConversationWorktreeMock.mockResolvedValue(undefined);
  });

  it("discards the worktree dir AND force-deletes the branch on delete", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [worktreeConversation()] } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation(CONV_ID);

    // Third arg true = the pkt/<id> branch goes too, not just the directory.
    expect(removeConversationWorktreeMock).toHaveBeenCalledWith("/repo", CONV_ID, true);
    expect(outcome).toEqual({
      worktreePath: "/repo/.pkt-worktrees/conv-del",
      branch: "pkt/conv-del",
      discarded: true,
    });
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
  }, 15_000);

  it("discards a DIRTY worktree without a second prompt — the confirm already disclosed it", async () => {
    getGitStatusMock.mockResolvedValue(" M src/foo.ts\n");
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [worktreeConversation()] } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation(CONV_ID);

    expect(removeConversationWorktreeMock).toHaveBeenCalledWith("/repo", CONV_ID, true);
    expect(outcome?.discarded).toBe(true);
  });

  it("keeps the delete when cleanup FAILS, and reports the failure instead of swallowing it", async () => {
    removeConversationWorktreeMock.mockRejectedValue(new Error("worktree is locked"));
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({ conversations: [worktreeConversation()] } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation(CONV_ID);

    expect(useAgentTaskStore.getState().conversations).toHaveLength(0); // delete survived
    expect(outcome).toMatchObject({
      worktreePath: "/repo/.pkt-worktrees/conv-del",
      branch: "pkt/conv-del",
      discarded: false,
      error: "worktree is locked",
    });
  });

  it("resolves null and removes nothing for a conversation that ran in the project root", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        worktreeConversation({ id: "root-conv", projectPath: "/repo", worktree: undefined }),
      ],
    } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation("root-conv");

    expect(outcome).toBeNull();
    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
  });

  it("leaves a remote (SSH) worktree alone — this app does not own it", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        worktreeConversation({
          id: "ssh-conv",
          sshTarget: { id: "s1", name: "host", host: "h", user: "u", remotePath: "/r" },
        }),
      ],
    } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation("ssh-conv");

    expect(outcome).toBeNull();
    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
  });

  it("does not re-discard a worktree already discarded from the lifecycle bar", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        worktreeConversation({
          worktree: {
            basePath: "/repo",
            worktreePath: "/repo/.pkt-worktrees/conv-del",
            branch: "pkt/conv-del",
            createdAt: Date.now(),
            state: "discarded",
          },
        }),
      ],
    } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation(CONV_ID);

    expect(outcome).toBeNull();
    expect(removeConversationWorktreeMock).not.toHaveBeenCalled();
  });

  it("still discards a LANDED worktree — merging back does not remove the checkout", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    useAgentTaskStore.setState({
      conversations: [
        worktreeConversation({
          worktree: {
            basePath: "/repo",
            worktreePath: "/repo/.pkt-worktrees/conv-del",
            branch: "pkt/conv-del",
            createdAt: Date.now(),
            state: "landed",
          },
        }),
      ],
    } as never);

    const outcome = await useAgentTaskStore.getState().deleteConversation(CONV_ID);

    expect(removeConversationWorktreeMock).toHaveBeenCalledWith("/repo", CONV_ID, true);
    expect(outcome?.discarded).toBe(true);
  });
});
