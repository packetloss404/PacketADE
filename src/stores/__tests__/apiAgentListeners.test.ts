import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

type EventListener = (event: { payload: unknown }) => void;

const listenMock = vi.fn();
const invokeMock = vi.fn();
const loadConversationsMock = vi.fn();
const sendApiAgentMessageMock = vi.fn();
let listeners: Map<string, EventListener>;

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/notifications", () => ({
  notifyConversationDone: vi.fn().mockResolvedValue(undefined),
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
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: (...args: unknown[]) => sendApiAgentMessageMock(...args),
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

function messageShape(message: AgentMessage) {
  return {
    role: message.role,
    content: message.content,
    queued: message.queued === true,
    streaming: message.isStreaming === true,
  };
}

describe("apiAgentListeners queued message drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    vi.doUnmock("@/stores/apiAgentListeners");
    localStorage.clear();
    listeners = new Map();
    listenMock.mockImplementation((eventName: string, callback: EventListener) => {
      listeners.set(eventName, callback);
      return Promise.resolve(() => {});
    });
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
    sendApiAgentMessageMock.mockResolvedValue(undefined);
  });

  it("promotes the drained queued bubble in place before the remaining queued messages", async () => {
    vi.useFakeTimers();
    try {
      const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
      const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
      const conv: AgentConversation = {
        id: "conv-order",
        title: "Queued order",
        agent: "api-openai",
        projectPath: "D:/projects/example",
        status: "active",
        messages: [
          makeMessage({ id: "msg-initial", content: "initial" }),
          makeMessage({
            id: "msg-current-assistant",
            role: "assistant",
            content: "current response",
            isStreaming: true,
          }),
          makeMessage({ id: "msg-queued-a", content: "queued A", queued: true }),
          makeMessage({ id: "msg-queued-b", content: "queued B", queued: true }),
        ],
        queuedMessages: ["queued A", "queued B"],
        sessionId: "conv-order",
        rawOutput: "",
        createdAt: 1,
        updatedAt: 1,
        mode: "api",
        provider: "openai",
        model: "gpt-4o",
      };
      useAgentTaskStore.setState({
        conversations: [conv],
        selectedConversationId: "conv-order",
      });

      await installApiAgentListeners("conv-order");
      listeners.get("api-agent:done:conv-order")?.({
        payload: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          resume_token: "resume-next",
        },
      });

      vi.runAllTimers();

      expect(sendApiAgentMessageMock).toHaveBeenCalledWith("conv-order", "queued A", undefined);

      const updated = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-order");
      expect(updated?.queuedMessages).toEqual(["queued B"]);
      expect(updated?.status).toBe("active");
      expect(updated?.messages.map(messageShape)).toEqual([
        { role: "user", content: "initial", queued: false, streaming: false },
        {
          role: "assistant",
          content: "current response",
          queued: false,
          streaming: false,
        },
        { role: "user", content: "queued A", queued: false, streaming: false },
        { role: "assistant", content: "", queued: false, streaming: true },
        { role: "user", content: "queued B", queued: true, streaming: false },
      ]);
      expect(
        updated?.messages.filter((m) => m.role === "user" && m.content === "queued A"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
