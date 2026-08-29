import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * STANDING CONTRACT GATE (tile-program P1-S3, C).
 *
 * Pins the frozen surface every later tile-program phase builds on. These are
 * not incidental unit tests — they are the guardrail that keeps the derived-
 * projection session model honest:
 *
 *  1. The Flight Deck attach contract: `createApiConversation({ explicitId,
 *     skipBackendStart: true })` reuses the caller's id as the session id AND
 *     fires ZERO backend session starts (asyncFlightStore attaches listeners to
 *     an already-running backend session — a spurious start would double-launch
 *     the agent).
 *  2. Conversation-file hydration round-trips the new `worktree` engine field
 *     and preserves unknown keys, while still stripping the legacy `workspaceId`
 *     mirror BY NAME (the derived-projection ruling: a conversation never gains
 *     a workspaceId).
 *  3. `canonicalizeAgentCli` alias resolution, at the surface and through
 *     hydration.
 *
 * Do NOT touch `events.rs` or `apiAgentListeners.ts` to satisfy this file.
 */

const listenMock = vi.fn();
const invokeMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const saveConversationMock = vi.fn();
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
      composeMemoryBrief: vi.fn(() => ({ text: "" })),
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
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: (...args: unknown[]) => saveConversationMock(...args),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("@/stores/agentTaskStore");
  localStorage.clear();
  listenMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue(undefined);
  startApiAgentSessionMock.mockResolvedValue(undefined);
  saveConversationMock.mockResolvedValue(undefined);
  loadConversationsMock.mockResolvedValue([]);
});

describe("sessionContract — createApiConversation backend-start contract", () => {
  it("skipBackendStart + explicitId: session id === explicitId and ZERO backend starts (Flight Deck attach)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    const explicitId = "attempt-session-123";
    const id = await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai",
      projectPath: "D:/projects/example",
      model: "gpt-4o",
      initialMessage: "attach",
      explicitId,
      skipBackendStart: true,
    });

    expect(id).toBe(explicitId);
    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === explicitId);
    expect(conv).toBeDefined();
    // For API mode the session id IS the conversation id (the api-agent event key).
    expect(conv?.sessionId).toBe(explicitId);
    // The whole point of skipBackendStart: the backend session already exists,
    // so we must NOT start a second one.
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("without skipBackendStart: exactly one backend start fires (the pin is meaningful)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai",
      projectPath: "D:/projects/example",
      model: "gpt-4o",
      initialMessage: "kickoff",
    });

    expect(startApiAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("explicitId becomes the conversation id verbatim (no re-generation)", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    const explicitId = "conv-explicit-abc";
    const id = await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai",
      projectPath: "D:/projects/example",
      model: "gpt-4o",
      initialMessage: "hi",
      explicitId,
      skipBackendStart: true,
    });

    expect(id).toBe(explicitId);
    expect(useAgentTaskStore.getState().conversations[0]?.id).toBe(explicitId);
  });
});

describe("sessionContract — conversation-file hydration round-trip", () => {
  function persistedRecord(overrides: Record<string, unknown> = {}): string {
    const now = Date.now();
    return JSON.stringify({
      id: "conv-hydrate-1",
      title: "Hydrated",
      agent: "api-openai",
      projectPath: "D:/projects/example",
      status: "done",
      messages: [],
      sessionId: "conv-hydrate-1",
      rawOutput: "",
      createdAt: now,
      updatedAt: now,
      mode: "api",
      ...overrides,
    });
  }

  it("preserves the new `worktree` engine field through hydration", async () => {
    const worktree = {
      basePath: "D:/projects/example",
      worktreePath: "D:/projects/example/.pkt-worktrees/conv-hydrate-1",
      branch: "pkt/conv-hydrate-1",
      baseBranch: "main",
      createdAt: 1700000000000,
      state: "active" as const,
    };
    loadConversationsMock.mockResolvedValue([persistedRecord({ worktree })]);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { hydrateConversations } = await import("@/stores/agentConversationPersistence");
    hydrateConversations();

    await vi.waitFor(() => {
      expect(
        useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-hydrate-1"),
      ).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-hydrate-1");
    expect(conv?.worktree).toEqual(worktree);
  });

  it("preserves unknown top-level keys through hydration (forward-compat)", async () => {
    loadConversationsMock.mockResolvedValue([
      persistedRecord({ someFutureField: { nested: 42 } }),
    ]);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { hydrateConversations } = await import("@/stores/agentConversationPersistence");
    hydrateConversations();

    await vi.waitFor(() => {
      expect(
        useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-hydrate-1"),
      ).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-hydrate-1");
    expect((conv as unknown as Record<string, unknown>).someFutureField).toEqual({ nested: 42 });
  });

  it("strips the legacy `workspaceId` mirror BY NAME at hydration (derived-projection ruling)", async () => {
    loadConversationsMock.mockResolvedValue([
      persistedRecord({ workspaceId: "ws-stale-legacy" }),
    ]);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { hydrateConversations } = await import("@/stores/agentConversationPersistence");
    hydrateConversations();

    await vi.waitFor(() => {
      expect(
        useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-hydrate-1"),
      ).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-hydrate-1");
    expect((conv as unknown as Record<string, unknown>).workspaceId).toBeUndefined();
  });

  it("persist side: a conversation carrying `worktree` serializes it (save/load survive)", async () => {
    vi.useFakeTimers();
    try {
      const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
      const { scheduleSave } = await import("@/stores/agentConversationPersistence");

      const worktree = {
        basePath: "D:/projects/example",
        worktreePath: "D:/projects/example/.pkt-worktrees/conv-persist-1",
        branch: "pkt/conv-persist-1",
        baseBranch: "develop",
        createdAt: 1700000000000,
        state: "active" as const,
      };
      const now = Date.now();
      const conv = {
        id: "conv-persist-1",
        title: "Persist me",
        agent: "api-openai" as const,
        projectPath: "D:/projects/example",
        status: "idle" as const,
        messages: [],
        sessionId: "conv-persist-1",
        rawOutput: "",
        createdAt: now,
        updatedAt: now,
        mode: "api" as const,
        worktree,
      };
      useAgentTaskStore.setState({ conversations: [conv] } as never);

      scheduleSave(conv as never);
      vi.advanceTimersByTime(600);

      expect(saveConversationMock).toHaveBeenCalledTimes(1);
      const [savedId, savedJson] = saveConversationMock.mock.calls[0] as [string, string];
      expect(savedId).toBe("conv-persist-1");
      const parsed = JSON.parse(savedJson);
      expect(parsed.worktree).toEqual(worktree);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sessionContract — canonicalizeAgentCli aliasing", () => {
  it("maps the retired `api-minimax-api` duplicate onto `api-minimax`", async () => {
    const { canonicalizeAgentCli } = await import("@/stores/agentTaskStore");
    expect(canonicalizeAgentCli("api-minimax-api")).toBe("api-minimax");
  });

  it("passes through canonical + unknown ids unchanged", async () => {
    const { canonicalizeAgentCli } = await import("@/stores/agentTaskStore");
    expect(canonicalizeAgentCli("api-openai")).toBe("api-openai");
    expect(canonicalizeAgentCli("api-claude")).toBe("api-claude");
    expect(canonicalizeAgentCli("some-future-provider")).toBe("some-future-provider");
  });

  it("hydration canonicalizes a persisted legacy agent id", async () => {
    const now = Date.now();
    loadConversationsMock.mockResolvedValue([
      JSON.stringify({
        id: "conv-alias-1",
        title: "Legacy agent",
        agent: "api-minimax-api",
        projectPath: "D:/projects/example",
        status: "idle",
        messages: [],
        sessionId: "conv-alias-1",
        rawOutput: "",
        createdAt: now,
        updatedAt: now,
        mode: "api",
      }),
    ]);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { hydrateConversations } = await import("@/stores/agentConversationPersistence");
    hydrateConversations();

    await vi.waitFor(() => {
      expect(
        useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-alias-1"),
      ).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-alias-1");
    expect(conv?.agent).toBe("api-minimax");
  });
});
