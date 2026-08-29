import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

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
  notifySessionComplete: vi.fn().mockResolvedValue(undefined),
  notifySessionError: vi.fn().mockResolvedValue(undefined),
  notifyApprovalNeeded: vi.fn(),
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
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

function makeConversation(id: string): AgentConversation {
  return {
    id,
    title: "MCP sources",
    agent: "api-claude",
    projectPath: "/proj",
    status: "active",
    messages: [{ id: "msg-user", role: "user", content: "go", timestamp: 1 }],
    sessionId: id,
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  };
}

async function setup(id: string) {
  const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
  const { installApiAgentListeners } = await import("@/stores/apiAgentListeners");
  useAgentTaskStore.setState({
    conversations: [makeConversation(id)],
    selectedConversationId: id,
  });
  await installApiAgentListeners(id);
  return { useAgentTaskStore };
}

describe("apiAgentListeners mcp_sources (S8-Phase-B Slice B)", () => {
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

  it("stamps conversation.mcpSources from the event", async () => {
    const { useAgentTaskStore } = await setup("conv-ok");
    listeners.get("api-agent:mcp-sources:conv-ok")?.({
      payload: {
        sources: [
          { name: "fs", transport: "stdio", scope: "global" },
          { name: "search", transport: "http", scope: "project" },
        ],
        readErrors: [],
      },
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-ok");
    expect(conv?.mcpSources?.sources.map((s) => s.name)).toEqual(["fs", "search"]);
    expect(conv?.mcpSources?.readErrors).toEqual([]);
    // No error → no system notice appended.
    expect(conv?.messages.some((m) => m.role === "system")).toBe(false);
  });

  it("appends a one-time system notice when readErrors are present", async () => {
    const { useAgentTaskStore } = await setup("conv-err");
    listeners.get("api-agent:mcp-sources:conv-err")?.({
      payload: {
        sources: [{ name: "fs", transport: "stdio", scope: "global" }],
        readErrors: [
          { scope: "project", path: "/proj/.mcp.json", message: "Unexpected token" },
        ],
      },
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-err");
    expect(conv?.mcpSources?.readErrors).toHaveLength(1);
    const notice = conv?.messages.find((m) => m.role === "system");
    expect(notice).toBeDefined();
    expect(notice?.content).toContain("/proj/.mcp.json");
    expect(notice?.content).toContain("remote MCP");
  });

  it("does not stack duplicate notices when the event re-fires (resume/retry)", async () => {
    const { useAgentTaskStore } = await setup("conv-retry");
    const payload = {
      payload: {
        sources: [{ name: "fs", transport: "stdio", scope: "global" }],
        readErrors: [
          { scope: "project", path: "/proj/.mcp.json", message: "Unexpected token" },
        ],
      },
    };
    // mcp_sources re-fires on every session (re)start — resume-after-restart
    // and retryLastTurn both re-issue createSession against the same persisted
    // message list. The notice must stay deduped to exactly one.
    listeners.get("api-agent:mcp-sources:conv-retry")?.(payload);
    listeners.get("api-agent:mcp-sources:conv-retry")?.(payload);
    listeners.get("api-agent:mcp-sources:conv-retry")?.(payload);

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-retry");
    const notices = conv?.messages.filter((m) => m.role === "system") ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toContain("/proj/.mcp.json");
  });

  it("clears a stale notice when a later summary reports no errors", async () => {
    const { useAgentTaskStore } = await setup("conv-heal");
    listeners.get("api-agent:mcp-sources:conv-heal")?.({
      payload: {
        sources: [],
        readErrors: [
          { scope: "project", path: "/proj/.mcp.json", message: "Unexpected token" },
        ],
      },
    });
    // Config fixed between restarts → next summary has no errors; the prior
    // notice must be dropped, not left dangling below the latest good state.
    listeners.get("api-agent:mcp-sources:conv-heal")?.({
      payload: {
        sources: [{ name: "fs", transport: "stdio", scope: "project" }],
        readErrors: [],
      },
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-heal");
    expect(conv?.messages.some((m) => m.role === "system")).toBe(false);
    expect(conv?.mcpSources?.sources.map((s) => s.name)).toEqual(["fs"]);
  });

  it("sets the field with no notice for an empty summary", async () => {
    const { useAgentTaskStore } = await setup("conv-empty");
    listeners.get("api-agent:mcp-sources:conv-empty")?.({
      payload: { sources: [], readErrors: [] },
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-empty");
    expect(conv?.mcpSources).toEqual({ sources: [], readErrors: [] });
    expect(conv?.messages.some((m) => m.role === "system")).toBe(false);
  });
});
