import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const closeApiAgentSessionMock = vi.fn();
const cancelApiAgentSessionMock = vi.fn();
const sendApiAgentMessageMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const loadConversationsMock = vi.fn();

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

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: vi.fn(() => ({
      findTaskBySessionId: vi.fn(() => null),
    })),
  },
}));

vi.mock("@/stores/orchestrationStore", () => ({
  useOrchestrationStore: {
    getState: vi.fn(() => ({
      onTaskApprovalNeeded: vi.fn().mockResolvedValue(undefined),
      onTaskApprovalResolved: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: (...args: unknown[]) => sendApiAgentMessageMock(...args),
  cancelApiAgentSession: (...args: unknown[]) => cancelApiAgentSessionMock(...args),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: (...args: unknown[]) => closeApiAgentSessionMock(...args),
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
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "msg-x",
    role: "user",
    content: "hello",
    timestamp: 1,
    ...overrides,
  };
}

function seedConversation(
  store: { getState: () => { conversations: AgentConversation[] }; setState: (s: Partial<{ conversations: AgentConversation[] }>) => void },
  conv: AgentConversation,
): void {
  store.setState({
    conversations: [conv, ...store.getState().conversations],
  });
}

describe("agentTaskStore.forkAndResend — current behavior lock-down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    closeApiAgentSessionMock.mockResolvedValue(undefined);
    cancelApiAgentSessionMock.mockResolvedValue(undefined);
    sendApiAgentMessageMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  it("truncates the conversation transcript to before the edited message", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const m1 = makeMessage({ id: "msg-1", content: "user one" });
    const m2 = makeMessage({ id: "msg-2", role: "assistant", content: "assistant one" });
    const m3 = makeMessage({ id: "msg-3", content: "user two — to edit" });
    const m4 = makeMessage({ id: "msg-4", role: "assistant", content: "assistant two" });
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [m1, m2, m3, m4],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    seedConversation(useAgentTaskStore, conv);

    await useAgentTaskStore.getState().forkAndResend("conv-A", "msg-3", "user two — edited");

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated).toBeDefined();
    // The first two messages survive truncation. forkAndResend then calls
    // sendMessage which itself appends the user turn + a streaming
    // assistant shell, so the post-fork length is implementation-defined;
    // assert only that the truncation prefix is preserved at the front.
    const surviving = updated!.messages.slice(0, 2);
    expect(surviving.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });

  it("clears the live session pointer + resume token so the next turn starts fresh", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [
        makeMessage({ id: "msg-1", content: "first" }),
        makeMessage({ id: "msg-2", content: "edit me" }),
      ],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
      resumeToken: "stale-token",
    };
    seedConversation(useAgentTaskStore, conv);

    await useAgentTaskStore.getState().forkAndResend("conv-A", "msg-2", "edited content");

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated?.sessionId).toBeNull();
    expect(updated?.resumeToken).toBeUndefined();
  });

  it("closes the live API session so a stale stream can't write into the new transcript", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-1", content: "edit me" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    seedConversation(useAgentTaskStore, conv);

    await useAgentTaskStore.getState().forkAndResend("conv-A", "msg-1", "edited");

    expect(closeApiAgentSessionMock).toHaveBeenCalledWith("conv-A");
  });

  it("wipes parked approvals + transient thinking state for the forked conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const { useAgentStreamingStore } = await import("@/stores/agentStreamingStore");

    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-1", content: "edit me" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    seedConversation(useAgentTaskStore, conv);
    useAgentApprovalStore.getState().addPendingPermission("conv-A", {
      id: "perm-1",
      name: "bash",
      arguments: "{}",
    });
    useAgentStreamingStore.getState().appendThinking("conv-A", "midstream...");

    await useAgentTaskStore.getState().forkAndResend("conv-A", "msg-1", "edited");

    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
    expect(useAgentStreamingStore.getState().thinkingStream.has("conv-A")).toBe(false);
  });

  it("is a no-op when the new content is whitespace-only", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [
        makeMessage({ id: "msg-1", content: "first" }),
        makeMessage({ id: "msg-2", content: "second" }),
      ],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    seedConversation(useAgentTaskStore, conv);

    await useAgentTaskStore.getState().forkAndResend("conv-A", "msg-2", "   ");

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated?.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(closeApiAgentSessionMock).not.toHaveBeenCalled();
  });

  // The audit description suggested forkAndResend should create a new
  // conversation with a `parentId` field referencing the source. The
  // current implementation truncates the source conversation in place
  // instead. Document the gap so a future refactor can flip this `todo`
  // into a real test without losing the requirement.
  it.todo(
    "forkAndResend should create a new conversation with parentConversationId set (current impl truncates in place)",
  );
});
