import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

const listenMock = vi.fn();
const invokeMock = vi.fn();
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

vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: {
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
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
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

describe("agentTaskStore.restoreCheckpoint — behavior lock-down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
  });

  it("resets the conversation's messages to the snapshot's payload", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [
        makeMessage({ id: "msg-now-1", content: "current 1" }),
        makeMessage({ id: "msg-now-2", role: "assistant", content: "current 2" }),
      ],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });

    const snapshotMessages: AgentMessage[] = [
      makeMessage({ id: "snap-1", content: "snapshot user" }),
      makeMessage({ id: "snap-2", role: "assistant", content: "snapshot assistant" }),
    ];
    const raw = JSON.stringify({
      createdAt: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
      messages: snapshotMessages,
    });

    useAgentTaskStore.getState().restoreCheckpoint("conv-A", raw);

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated?.messages.map((m) => m.id)).toEqual(["snap-1", "snap-2"]);
    expect(updated?.messages.map((m) => m.content)).toEqual([
      "snapshot user",
      "snapshot assistant",
    ]);
  });

  it("strips isStreaming=true off snapshot messages so the UI doesn't render a phantom turn", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-now" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });

    const raw = JSON.stringify({
      messages: [
        makeMessage({ id: "snap-streaming", role: "assistant", isStreaming: true }),
      ],
    });

    useAgentTaskStore.getState().restoreCheckpoint("conv-A", raw);

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated?.messages[0].isStreaming).toBeFalsy();
  });

  it("accepts a bare-array snapshot payload (legacy format)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-now" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });

    const raw = JSON.stringify([makeMessage({ id: "legacy-1", content: "legacy" })]);

    useAgentTaskStore.getState().restoreCheckpoint("conv-A", raw);

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated?.messages.map((m) => m.id)).toEqual(["legacy-1"]);
  });

  it("ignores invalid JSON without throwing or wiping the conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const original = makeMessage({ id: "msg-keep", content: "keep me" });
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [original],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    useAgentTaskStore.getState().restoreCheckpoint("conv-A", "not-valid-json");

    const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-A");
    expect(updated?.messages).toEqual([original]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // restoreCheckpoint must also wipe per-conversation substore state
  // (pending permissions, plan/spec, thinking buffer) — a checkpoint
  // captures only `messages`, so any post-snapshot pending state must
  // be discarded to avoid stale UI sticking after the restore.
  it("clears agentApprovalStore pending entries for the restored conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-now" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });
    useAgentApprovalStore.getState().addPendingPermission("conv-A", {
      id: "perm-1",
      name: "bash",
      arguments: "{}",
    });

    useAgentTaskStore
      .getState()
      .restoreCheckpoint("conv-A", JSON.stringify({ messages: [] }));

    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
    expect(useAgentApprovalStore.getState().edits.has("conv-A")).toBe(false);
  });

  it("clears agentPlanStore spec / plan entries for the restored conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-now" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });
    useAgentPlanStore.getState().setSpec("conv-A", ["stale criterion"]);
    useAgentPlanStore.getState().setPlan("conv-A", [
      { id: "stale", content: "stale plan", status: "pending" },
    ]);

    useAgentTaskStore
      .getState()
      .restoreCheckpoint("conv-A", JSON.stringify({ messages: [] }));

    expect(useAgentPlanStore.getState().spec.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().plan.has("conv-A")).toBe(false);
  });

  it("clears agentStreamingStore thinking buffer for the restored conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { useAgentStreamingStore } = await import("@/stores/agentStreamingStore");
    const conv: AgentConversation = {
      id: "conv-A",
      title: "Test",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "idle",
      messages: [makeMessage({ id: "msg-now" })],
      sessionId: "conv-A",
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
    useAgentTaskStore.setState({ conversations: [conv] });
    useAgentStreamingStore.getState().appendThinking("conv-A", "stale thinking");

    useAgentTaskStore
      .getState()
      .restoreCheckpoint("conv-A", JSON.stringify({ messages: [] }));

    expect(useAgentStreamingStore.getState().thinkingStream.has("conv-A")).toBe(false);
  });
});
