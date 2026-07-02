import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("apiAgentListeners chunk coalescing", () => {
  let rafCallbacks: FrameRequestCallback[];

  function runFrame() {
    const callbacks = rafCallbacks;
    rafCallbacks = [];
    for (const cb of callbacks) cb(performance.now());
  }

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
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeStreamingConversation(id: string): AgentConversation {
    return {
      id,
      title: "Streaming",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "active",
      messages: [
        makeMessage({ id: "msg-user", content: "go" }),
        makeMessage({
          id: "msg-assistant",
          role: "assistant",
          content: "",
          isStreaming: true,
        }),
      ],
      sessionId: id,
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "openai",
      model: "gpt-4o",
    };
  }

  it("buffers a chunk burst and applies it as a single ordered store write per frame", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    useAgentTaskStore.setState({
      conversations: [makeStreamingConversation("conv-burst")],
      selectedConversationId: "conv-burst",
    });
    await installApiAgentListeners("conv-burst");

    const writes = vi.fn();
    const unsubscribe = useAgentTaskStore.subscribe(writes);
    const chunk = listeners.get("api-agent:chunk:conv-burst");
    const thinking = listeners.get("api-agent:thinking:conv-burst");

    chunk?.({ payload: "Hel" });
    chunk?.({ payload: "lo " });
    thinking?.({ payload: { text: "pondering" } });
    chunk?.({ payload: "world" });

    // Nothing lands until the frame flush — per-token store writes are gone.
    expect(writes).not.toHaveBeenCalled();

    runFrame();

    expect(writes).toHaveBeenCalledTimes(1);
    const msg = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-burst")
      ?.messages.find((m) => m.role === "assistant");
    expect(msg?.content).toBe("Hello world");
    expect(msg?.thinking).toBe("pondering");
    expect(msg?.isStreaming).toBe(true);
    unsubscribe();
  });

  it("flushes buffered tail chunks before `done` settles the message (no lost chunks)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    useAgentTaskStore.setState({
      conversations: [makeStreamingConversation("conv-settle")],
      selectedConversationId: "conv-settle",
    });
    await installApiAgentListeners("conv-settle");

    const chunk = listeners.get("api-agent:chunk:conv-settle");
    chunk?.({ payload: "final " });
    chunk?.({ payload: "words" });
    // `done` arrives while a flush is still pending in the frame queue.
    listeners.get("api-agent:done:conv-settle")?.({
      payload: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    // A late frame after settle must not re-apply anything.
    runFrame();

    const msg = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-settle")
      ?.messages.find((m) => m.role === "assistant");
    expect(msg?.content).toBe("final words");
    expect(msg?.isStreaming).toBe(false);
  });
});

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
