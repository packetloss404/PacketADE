import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentMessage } from "@/types/agent-conversation";

type EventListener = (event: { payload: unknown }) => void;

const listenMock = vi.fn();
const invokeMock = vi.fn();
const loadConversationsMock = vi.fn();
const sendApiAgentMessageMock = vi.fn();
const respondPermissionTauriMock = vi.fn();
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

const notifyApprovalNeededMock = vi.fn();

vi.mock("@/lib/notifications", () => ({
  notifyConversationDone: vi.fn().mockResolvedValue(undefined),
  notifySessionComplete: vi.fn().mockResolvedValue(undefined),
  notifySessionError: vi.fn().mockResolvedValue(undefined),
  notifyApprovalNeeded: (...args: unknown[]) => notifyApprovalNeededMock(...args),
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
  respondPermission: (...args: unknown[]) => respondPermissionTauriMock(...args),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
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

/**
 * P1-7: baseline recording + tool-input plumbing. Every edit-bearing tool
 * call must store its pre-edit content (from `pending_edit.before` for
 * gated writes, from `edit_baseline` for auto-applied ones), and the raw
 * tool input delivered on tool_start (sidecar path) must survive the
 * tool_result merge so the transcript edit layer can parse it.
 */
describe("apiAgentListeners baseline recording", () => {
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

  function makeApiConversation(id: string): AgentConversation {
    return {
      id,
      title: "Baselines",
      agent: "api-claude",
      projectPath: "/proj",
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
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    };
  }

  it("records the pre-edit baseline from pending_edit.before (gated writes)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    const { useEditBaselineStore } = await import("@/stores/editBaselineStore");
    useAgentTaskStore.setState({
      conversations: [makeApiConversation("conv-pe")],
      selectedConversationId: "conv-pe",
    });
    await installApiAgentListeners("conv-pe");

    listeners.get("api-agent:pending-edit:conv-pe")?.({
      payload: {
        id: "tc-1",
        path: "src/a.ts",
        content: "after content",
        before: "before content",
      },
    });

    const store = useEditBaselineStore.getState();
    expect(store.getBaseline("conv-pe", "src/a.ts")).toEqual({
      content: "before content",
    });
    expect(store.getToolCallBaseline("tc-1")).toEqual({
      conversationId: "conv-pe",
      path: "src/a.ts",
      content: "before content",
    });
  });

  it("records baselines from edit_baseline events (auto-applied writes), null for new files", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    const { useEditBaselineStore } = await import("@/stores/editBaselineStore");
    useAgentTaskStore.setState({
      conversations: [makeApiConversation("conv-eb")],
      selectedConversationId: "conv-eb",
    });
    await installApiAgentListeners("conv-eb");

    const emit = listeners.get("api-agent:edit-baseline:conv-eb");
    expect(emit).toBeDefined();
    emit?.({
      payload: { id: "tc-1", path: "src/a.ts", before: "original body" },
    });
    // `before` absent = the file did not exist.
    emit?.({ payload: { id: "tc-2", path: "src/new.ts" } });

    const store = useEditBaselineStore.getState();
    expect(store.getBaseline("conv-eb", "src/a.ts")).toEqual({
      content: "original body",
    });
    expect(store.getBaseline("conv-eb", "src/new.ts")).toEqual({
      content: null,
    });
    expect(store.getToolCallBaseline("tc-2")?.content).toBeNull();
  });

  it("relativizes absolute runtime paths so baseline keys match the canonical descriptors", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    const { useEditBaselineStore } = await import("@/stores/editBaselineStore");
    useAgentTaskStore.setState({
      conversations: [makeApiConversation("conv-abs")],
      selectedConversationId: "conv-abs",
    });
    await installApiAgentListeners("conv-abs");

    // Claude Code's PreToolUse hook emits the raw absolute file_path; the
    // transcript edit layer keys project-relative — the recorded baseline
    // must land under the relative key or no surface ever finds it.
    listeners.get("api-agent:edit-baseline:conv-abs")?.({
      payload: { id: "tc-1", path: "/proj/src/a.ts", before: "v0" },
    });
    listeners.get("api-agent:pending-edit:conv-abs")?.({
      payload: {
        id: "tc-2",
        path: "/proj/src/b.ts",
        content: "after",
        before: "v0b",
      },
    });

    const store = useEditBaselineStore.getState();
    expect(store.getBaseline("conv-abs", "src/a.ts")).toEqual({ content: "v0" });
    expect(store.getBaseline("conv-abs", "src/b.ts")).toEqual({ content: "v0b" });
    expect(store.getToolCallBaseline("tc-1")?.path).toBe("src/a.ts");

    // The stored pending edit itself must carry the relative path too: the
    // review surface dedupes/deep-links/labels pending edits against the
    // transcript's project-relative keys, so a raw absolute path renders the
    // same file twice and double-counts it in every badge.
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const pending = useAgentApprovalStore.getState().edits.get("conv-abs");
    expect(pending?.map((e) => e.path)).toEqual(["src/b.ts"]);
  });

  it("keeps the first recorded baseline per path across repeated edits", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    const { useEditBaselineStore } = await import("@/stores/editBaselineStore");
    useAgentTaskStore.setState({
      conversations: [makeApiConversation("conv-fw")],
      selectedConversationId: "conv-fw",
    });
    await installApiAgentListeners("conv-fw");

    const emit = listeners.get("api-agent:edit-baseline:conv-fw");
    emit?.({ payload: { id: "tc-1", path: "src/a.ts", before: "v0" } });
    // Second edit of the same file in the turn: `before` is now the
    // intermediate state — must NOT replace the pre-turn baseline.
    emit?.({ payload: { id: "tc-2", path: "src/a.ts", before: "v1" } });

    const store = useEditBaselineStore.getState();
    expect(store.getBaseline("conv-fw", "src/a.ts")).toEqual({ content: "v0" });
    expect(store.getToolCallBaseline("tc-2")?.content).toBe("v1");
  });

  it("stores tool input from tool_start and keeps it when tool_result omits it (sidecar path)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    useAgentTaskStore.setState({
      conversations: [makeApiConversation("conv-in")],
      selectedConversationId: "conv-in",
    });
    await installApiAgentListeners("conv-in");

    const writeInput = JSON.stringify({
      file_path: "/proj/src/a.ts",
      content: "body\n",
    });
    listeners.get("api-agent:tool-start:conv-in")?.({
      payload: { id: "tc-1", name: "Write", input: writeInput },
    });
    // Sidecar results don't echo the input back (empty string from Rust).
    listeners.get("api-agent:tool-result:conv-in")?.({
      payload: {
        id: "tc-1",
        name: "",
        content: "ok",
        is_error: false,
        input: "",
      },
    });

    const conv = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-in");
    const tc = conv?.messages
      .flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === "tc-1");
    expect(tc?.status).toBe("done");
    expect(tc?.name).toBe("Write");
    expect(tc?.input).toBe(writeInput);
  });

  it("still prefers the tool_result input when one is provided (in-process path)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    useAgentTaskStore.setState({
      conversations: [makeApiConversation("conv-ip")],
      selectedConversationId: "conv-ip",
    });
    await installApiAgentListeners("conv-ip");

    listeners.get("api-agent:tool-start:conv-ip")?.({
      payload: { id: "tc-1", name: "write_file" },
    });
    const resultInput = JSON.stringify({ path: "src/b.ts", content: "x" });
    listeners.get("api-agent:tool-result:conv-ip")?.({
      payload: {
        id: "tc-1",
        name: "write_file",
        content: "ok",
        is_error: false,
        input: resultInput,
      },
    });

    const conv = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-ip");
    const tc = conv?.messages
      .flatMap((m) => m.toolCalls ?? [])
      .find((t) => t.id === "tc-1");
    expect(tc?.input).toBe(resultInput);
  });
});

describe("apiAgentListeners tiered approval gating (P1-9)", () => {
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
    respondPermissionTauriMock.mockResolvedValue(undefined);
  });

  function makeConversation(
    id: string,
    overrides: Partial<AgentConversation> = {},
  ): AgentConversation {
    return {
      id,
      title: "Gating",
      agent: "api-claude",
      projectPath: "/proj",
      status: "active",
      messages: [makeMessage({ id: "msg-user", content: "go" })],
      sessionId: id,
      rawOutput: "",
      createdAt: 1,
      updatedAt: 1,
      mode: "api",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      permissionMode: "auto",
      planMode: false,
      ...overrides,
    };
  }

  async function setup(conv: AgentConversation) {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    useAgentTaskStore.setState({
      conversations: [conv],
      selectedConversationId: conv.id,
    });
    await installApiAgentListeners(conv.id);
    return { useAgentApprovalStore };
  }

  it("auto-allows read/search tools without a prompt or a notification (Default mode)", async () => {
    const { useAgentApprovalStore } = await setup(makeConversation("conv-read"));

    listeners.get("api-agent:permission-request:conv-read")?.({
      payload: { id: "tool-1", name: "Grep", arguments: '{"pattern":"foo"}' },
    });

    expect(respondPermissionTauriMock).toHaveBeenCalledWith(
      "conv-read",
      "tool-1",
      "allow_once",
    );
    expect(useAgentApprovalStore.getState().permissions.has("conv-read")).toBe(false);
    expect(notifyApprovalNeededMock).not.toHaveBeenCalled();
  });

  it("auto-applies in-project edits into the post-hoc review path (Default mode)", async () => {
    const { useAgentApprovalStore } = await setup(makeConversation("conv-edit"));

    listeners.get("api-agent:permission-request:conv-edit")?.({
      payload: {
        id: "tool-2",
        name: "Write",
        arguments: JSON.stringify({ file_path: "/proj/src/a.ts", content: "x" }),
      },
    });

    expect(respondPermissionTauriMock).toHaveBeenCalledWith(
      "conv-edit",
      "tool-2",
      "allow_once",
    );
    expect(useAgentApprovalStore.getState().permissions.has("conv-edit")).toBe(false);
  });

  it("blocks shell tools with a prompt and pings the user", async () => {
    const { useAgentApprovalStore } = await setup(makeConversation("conv-shell"));

    listeners.get("api-agent:permission-request:conv-shell")?.({
      payload: { id: "tool-3", name: "bash", arguments: '{"command":"rm -rf /"}' },
    });

    expect(respondPermissionTauriMock).not.toHaveBeenCalled();
    expect(
      useAgentApprovalStore.getState().permissions.get("conv-shell")?.map((p) => p.id),
    ).toEqual(["tool-3"]);
    expect(notifyApprovalNeededMock).toHaveBeenCalledWith("conv-shell", "Gating");
  });

  it("blocks out-of-project writes even under Default mode", async () => {
    const { useAgentApprovalStore } = await setup(makeConversation("conv-out"));

    listeners.get("api-agent:permission-request:conv-out")?.({
      payload: {
        id: "tool-4",
        name: "Write",
        arguments: JSON.stringify({ file_path: "/etc/hosts", content: "x" }),
      },
    });

    expect(respondPermissionTauriMock).not.toHaveBeenCalled();
    expect(
      useAgentApprovalStore.getState().permissions.get("conv-out")?.map((p) => p.id),
    ).toEqual(["tool-4"]);
  });

  it("manual mode (ask_for_risky) still prompts for in-project edits but not reads", async () => {
    const { useAgentApprovalStore } = await setup(
      makeConversation("conv-manual", { permissionMode: "ask_for_risky" }),
    );

    const emit = listeners.get("api-agent:permission-request:conv-manual");
    emit?.({ payload: { id: "tool-5", name: "read_file", arguments: '{"path":"a.ts"}' } });
    emit?.({
      payload: {
        id: "tool-6",
        name: "Write",
        arguments: JSON.stringify({ file_path: "/proj/src/a.ts", content: "x" }),
      },
    });

    expect(respondPermissionTauriMock).toHaveBeenCalledWith(
      "conv-manual",
      "tool-5",
      "allow_once",
    );
    expect(
      useAgentApprovalStore.getState().permissions.get("conv-manual")?.map((p) => p.id),
    ).toEqual(["tool-6"]);
  });

  it("plan mode keeps its stricter behavior: even reads prompt", async () => {
    const { useAgentApprovalStore } = await setup(
      makeConversation("conv-plan", { planMode: true }),
    );

    listeners.get("api-agent:permission-request:conv-plan")?.({
      payload: { id: "tool-7", name: "Grep", arguments: "{}" },
    });

    expect(respondPermissionTauriMock).not.toHaveBeenCalled();
    expect(
      useAgentApprovalStore.getState().permissions.get("conv-plan")?.map((p) => p.id),
    ).toEqual(["tool-7"]);
  });

  it("deny-risky mode keeps its stricter behavior: everything that arrives prompts", async () => {
    const { useAgentApprovalStore } = await setup(
      makeConversation("conv-deny", { permissionMode: "deny_all" }),
    );

    listeners.get("api-agent:permission-request:conv-deny")?.({
      payload: { id: "tool-8", name: "read_file", arguments: '{"path":"a.ts"}' },
    });

    expect(respondPermissionTauriMock).not.toHaveBeenCalled();
    expect(
      useAgentApprovalStore.getState().permissions.get("conv-deny")?.map((p) => p.id),
    ).toEqual(["tool-8"]);
  });
});
