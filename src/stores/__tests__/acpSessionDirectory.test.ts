/**
 * The ACP engine's session surface, as the store exposes it.
 *
 * Three separate contracts are defended here, and they fail in different
 * directions:
 *
 *  1. **The directory degrades to nothing, never to an error state that lies.**
 *     `acp::list_sessions_on` already falls back from the vendor method to a
 *     `~/.packetcode/sessions/*.json` read and from there to an empty list, so
 *     an EMPTY array is a real answer ("the engine holds no sessions") and a
 *     REJECTED query is a different one ("we could not ask"). Collapsing them
 *     would either invent a failure or claim knowledge we never obtained.
 *
 *  2. **Resume re-stamps the engine's capabilities.** A resume creates a
 *     brand-new engine session, so the capability block on the record may
 *     describe an engine that has since changed. Stamping is best-effort and
 *     must never be able to fail the resume.
 *
 *  3. **Resume says out loud that the engine's context is empty.** For a
 *     conversation PacketADE started, ACP has no mid-life resume: the ACP
 *     branch calls `session/new` and ignores the `resumeMessages` every other
 *     transport replays. The transcript above the resume boundary is
 *     PacketADE's own, complete, and NOT shared with the model — which is
 *     invisible unless it is said.
 *
 *  4. **Adoption is the other direction, and is honest the other way round.**
 *     A conversation bound to an engine session (`acpEngineSessionId`) resumes
 *     it with `session/load`, so the model DOES have the history — and
 *     PacketADE does not: ACP's replay omits the user's own turns, so none of
 *     it is rendered. The adopted conversation says that once, at the top, and
 *     the resume boundary then says nothing, because there is no context reset
 *     to report.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every test here resets the module registry and re-imports the whole
// `agentTaskStore` graph. That cold import is seconds of transform work on
// Windows under parallel suite load, so the default 5s budget is too tight —
// the same reason `agentTaskStoreRename.test.ts` widens its first test.
vi.setConfig({ testTimeout: 30_000 });

const listenMock = vi.fn();
const invokeMock = vi.fn();
const acpStartMock = vi.fn();
const acpCapabilitiesMock = vi.fn();
const acpListModelsMock = vi.fn();
const acpListSessionsMock = vi.fn();
const acpRenameSessionMock = vi.fn();
const startApiAgentSessionMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

// Partial mock: only the calls this file drives are stubbed, so a rename or
// removal anywhere else in `lib/tauri` still fails loudly here.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  acpStart: (...args: unknown[]) => acpStartMock(...args),
  acpCapabilities: (...args: unknown[]) => acpCapabilitiesMock(...args),
  acpListModels: (...args: unknown[]) => acpListModelsMock(...args),
  acpListSessions: (...args: unknown[]) => acpListSessionsMock(...args),
  acpRenameSession: (...args: unknown[]) => acpRenameSessionMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
}));

import type { AcpEngineCapabilities, AcpSessionSummary } from "@/lib/tauri";

function engineCaps(
  over: Partial<AcpEngineCapabilities["packetcode"]> = {},
): AcpEngineCapabilities {
  return {
    protocolVersion: 1,
    loadSession: true,
    sessionClose: true,
    packetcode: {
      advertised: true,
      sessionsList: true,
      sessionsRename: true,
      sessionsUsage: true,
      modelsList: false,
      mcpList: true,
      mcpDefaults: true,
      permissionModes: ["ask", "read-only"],
      defaultPermissionMode: "read-only",
      ...over,
    },
  };
}

function engineSession(over: Partial<AcpSessionSummary> = {}): AcpSessionSummary {
  return {
    sessionId: "eng-1",
    name: "Refactor the router",
    updatedAt: "2026-08-25T10:00:00Z",
    provider: "anthropic",
    model: "claude-opus-4-8",
    workingDir: "D:/projects/example",
    messageCount: 12,
    costUsd: 0.42,
    ...over,
  };
}

function seedConversation(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "conv-acp",
    title: "Engine session",
    agent: "api-packetcode",
    projectPath: "D:/projects/example",
    status: "idle",
    messages: [
      { id: "m1", role: "user", content: "earlier turn", timestamp: now - 1000 },
      { id: "m2", role: "assistant", content: "earlier answer", timestamp: now - 900 },
    ],
    sessionId: null,
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    provider: "packetcode-acp",
    model: "claude-opus-4-8",
    archived: false,
    ...over,
  };
}

async function store() {
  const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
  return useAgentTaskStore;
}

describe("agentTaskStore — the engine session directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    acpStartMock.mockResolvedValue(undefined);
    acpCapabilitiesMock.mockResolvedValue(engineCaps());
    acpListModelsMock.mockResolvedValue([]);
    acpListSessionsMock.mockResolvedValue([engineSession()]);
    acpRenameSessionMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  it("brings the engine up before reading its directory", async () => {
    // The engine is lazy — nothing starts it until a conversation does — so a
    // directory read asked before any ACP conversation exists has to.
    const useAgentTaskStore = await store();
    await useAgentTaskStore.getState().refreshEngineSessions();

    expect(acpStartMock).toHaveBeenCalled();
    expect(useAgentTaskStore.getState().engineSessions).toHaveLength(1);
    expect(useAgentTaskStore.getState().engineSessionsStatus).toBe("ready");
    expect(useAgentTaskStore.getState().engineCapabilities).toEqual(engineCaps());
  });

  it("treats an empty listing as a real answer, not a failure", async () => {
    // The backend degrades `_packetcode/sessions/list` to a disk read and that
    // to `[]`, so this is the ordinary "no engine sessions" case.
    acpListSessionsMock.mockResolvedValue([]);
    const useAgentTaskStore = await store();

    await useAgentTaskStore.getState().refreshEngineSessions();

    expect(useAgentTaskStore.getState().engineSessions).toEqual([]);
    expect(useAgentTaskStore.getState().engineSessionsStatus).toBe("ready");
  });

  it("degrades a rejected listing to empty and never rejects", async () => {
    acpListSessionsMock.mockRejectedValue(new Error("engine not started"));
    const useAgentTaskStore = await store();

    await expect(useAgentTaskStore.getState().refreshEngineSessions()).resolves.toBeUndefined();

    expect(useAgentTaskStore.getState().engineSessions).toEqual([]);
    // `unavailable`, NOT `ready`: we did not learn that there are no sessions,
    // we failed to ask.
    expect(useAgentTaskStore.getState().engineSessionsStatus).toBe("unavailable");
  });

  it("still lists when the engine could not be started", async () => {
    // `acp_list_sessions` can answer from disk with no engine running, so a
    // failed start must not short-circuit the read.
    acpStartMock.mockRejectedValue(new Error("packetcode not on PATH"));
    const useAgentTaskStore = await store();

    await useAgentTaskStore.getState().refreshEngineSessions();

    expect(useAgentTaskStore.getState().engineSessionsStatus).toBe("ready");
    expect(useAgentTaskStore.getState().engineSessions).toHaveLength(1);
  });

  it("keeps the engine's capabilities even when the listing fails", async () => {
    // They are what decides whether an engine row may be renamed; losing them
    // would take an affordance away over an unrelated failure.
    acpListSessionsMock.mockRejectedValue(new Error("transport closed"));
    const useAgentTaskStore = await store();

    await useAgentTaskStore.getState().refreshEngineSessions();

    expect(useAgentTaskStore.getState().engineCapabilities).toEqual(engineCaps());
  });

  it("never merges engine sessions into the conversation list", async () => {
    // The whole point of the separate slice: an engine session has no local
    // transcript, so nothing may render it as a conversation.
    const useAgentTaskStore = await store();
    await useAgentTaskStore.getState().refreshEngineSessions();

    expect(useAgentTaskStore.getState().conversations).toEqual([]);
  });
});

describe("agentTaskStore — engine-side rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    acpStartMock.mockResolvedValue(undefined);
    acpCapabilitiesMock.mockResolvedValue(engineCaps());
    acpListModelsMock.mockResolvedValue([]);
    acpListSessionsMock.mockResolvedValue([engineSession()]);
    acpRenameSessionMock.mockResolvedValue(undefined);
  });

  it("pushes a local ACP conversation's new title out to the engine", async () => {
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    useAgentTaskStore.getState().renameConversation("conv-acp", "New title");
    await useAgentTaskStore.getState().pushEngineRename("conv-acp", "New title");

    // PacketADE's conversation id — the backend maps it to the engine's own.
    expect(acpRenameSessionMock).toHaveBeenCalledWith("conv-acp", "New title");
    expect(
      useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-acp")?.title,
    ).toBe("New title");
  });

  it("leaves the local title standing when the engine refuses the rename", async () => {
    acpRenameSessionMock.mockRejectedValue(new Error("-32603 internal"));
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    useAgentTaskStore.getState().renameConversation("conv-acp", "New title");
    // Neither throws nor reverts — the local record is the user's, and the
    // engine's opinion of it arrives second.
    await expect(
      useAgentTaskStore.getState().pushEngineRename("conv-acp", "New title"),
    ).resolves.toBeUndefined();

    expect(
      useAgentTaskStore.getState().conversations.find((c) => c.id === "conv-acp")?.title,
    ).toBe("New title");
  });

  it("does not push a non-ACP conversation's title anywhere", async () => {
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({
      conversations: [seedConversation({ agent: "api-openai", provider: "openai" })],
    } as never);

    await useAgentTaskStore.getState().pushEngineRename("conv-acp", "New title");

    expect(acpRenameSessionMock).not.toHaveBeenCalled();
  });

  it("renames an engine-only row optimistically", async () => {
    const useAgentTaskStore = await store();
    await useAgentTaskStore.getState().refreshEngineSessions();

    const pending = useAgentTaskStore.getState().renameEngineSession("eng-1", "Renamed remotely");
    // Optimistic: the row changes before the engine has answered.
    expect(useAgentTaskStore.getState().engineSessions[0]?.name).toBe("Renamed remotely");
    await pending;
    expect(acpRenameSessionMock).toHaveBeenCalledWith("eng-1", "Renamed remotely");
  });

  it("re-reads the directory when an engine-only rename is refused", async () => {
    const useAgentTaskStore = await store();
    await useAgentTaskStore.getState().refreshEngineSessions();
    acpRenameSessionMock.mockRejectedValue(new Error("-32603 internal"));

    await useAgentTaskStore.getState().renameEngineSession("eng-1", "Renamed remotely");
    // The engine's store is the ONLY record of this name, so an optimistic row
    // the engine rejected is a lie — truth is re-read rather than kept.
    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().engineSessions[0]?.name).toBe("Refactor the router");
    });
  });
});

describe("agentTaskStore — resuming an ACP conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    acpStartMock.mockResolvedValue(undefined);
    acpCapabilitiesMock.mockResolvedValue(engineCaps());
    acpListModelsMock.mockResolvedValue([]);
    acpListSessionsMock.mockResolvedValue([]);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  it("re-stamps the engine's capabilities onto the resumed record", async () => {
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    await useAgentTaskStore.getState().resumeApiConversation("conv-acp", "next turn");

    await vi.waitFor(() => {
      const conversation = useAgentTaskStore
        .getState()
        .conversations.find((c) => c.id === "conv-acp");
      expect(conversation?.engineCapabilities).toEqual(engineCaps());
    });
  });

  it("records that the engine's own context starts empty", async () => {
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    await useAgentTaskStore.getState().resumeApiConversation("conv-acp", "next turn");

    const conversation = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-acp");
    const notice = conversation?.messages.find((m) => m.role === "system");
    expect(notice?.content).toMatch(/does not carry the earlier turns/);
    // It sits at the resume BOUNDARY: after the pre-existing transcript and
    // before the turn it applies to, which is where it is true.
    const ids = conversation?.messages.map((m) => m.id) ?? [];
    expect(ids.indexOf(notice!.id)).toBeGreaterThan(ids.indexOf("m2"));
    const userTurn = conversation?.messages.find((m) => m.content === "next turn");
    expect(ids.indexOf(notice!.id)).toBeLessThan(ids.indexOf(userTurn!.id));
  });

  it("says nothing of the sort on a transport that really does replay", async () => {
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({
      conversations: [seedConversation({ agent: "api-openai", provider: "openai" })],
    } as never);

    await useAgentTaskStore.getState().resumeApiConversation("conv-acp", "next turn");

    const conversation = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-acp");
    expect(conversation?.messages.some((m) => m.role === "system")).toBe(false);
    expect(acpCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("does not fail the resume when the capability re-stamp is refused", async () => {
    acpCapabilitiesMock.mockRejectedValue(new Error("engine not started"));
    const useAgentTaskStore = await store();
    useAgentTaskStore.setState({ conversations: [seedConversation()] } as never);

    await expect(
      useAgentTaskStore.getState().resumeApiConversation("conv-acp", "next turn"),
    ).resolves.toBeUndefined();

    expect(startApiAgentSessionMock).toHaveBeenCalled();
    const conversation = useAgentTaskStore
      .getState()
      .conversations.find((c) => c.id === "conv-acp");
    expect(conversation?.status).not.toBe("failed");
    expect(conversation?.engineCapabilities).toBeUndefined();
  });
});

describe("agentTaskStore — adopting an engine session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    acpStartMock.mockResolvedValue(undefined);
    acpCapabilitiesMock.mockResolvedValue(engineCaps());
    acpListModelsMock.mockResolvedValue([]);
    acpListSessionsMock.mockResolvedValue([engineSession()]);
    startApiAgentSessionMock.mockResolvedValue(undefined);
  });

  async function seededStore() {
    const useAgentTaskStore = await store();
    await useAgentTaskStore.getState().refreshEngineSessions();
    return useAgentTaskStore;
  }

  it("binds a new conversation to the engine's session id", async () => {
    const useAgentTaskStore = await seededStore();

    const id = await useAgentTaskStore.getState().adoptEngineSession("eng-1");

    expect(id).toBeTruthy();
    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);
    expect(conversation?.acpEngineSessionId).toBe("eng-1");
    expect(conversation?.provider).toBe("packetcode-acp");
    // The row's own facts, not invented ones.
    expect(conversation?.projectPath).toBe("D:/projects/example");
    expect(conversation?.model).toBe("claude-opus-4-8");
    expect(conversation?.title).toBe("Refactor the router");
    // Selected, so the click that adopted it also opened it.
    expect(useAgentTaskStore.getState().selectedConversationId).toBe(id);
  });

  it("starts nothing on the engine — adoption is a local record", async () => {
    const useAgentTaskStore = await seededStore();
    startApiAgentSessionMock.mockClear();

    await useAgentTaskStore.getState().adoptEngineSession("eng-1");

    // No session start and no load. `session/load` happens when the user
    // sends, which is the moment the resumed session is actually needed and
    // the moment a failure has somewhere honest to land.
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("says up front that it holds no transcript for the session", async () => {
    const useAgentTaskStore = await seededStore();

    const id = await useAgentTaskStore.getState().adoptEngineSession("eng-1");
    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);

    // The whole honesty story for an adopted session, stated once and durably:
    // the engine has the history, PacketADE does not, and the replay that
    // would have carried it leaves out the user's own turns.
    expect(conversation?.messages).toHaveLength(1);
    const notice = conversation.messages[0];
    expect(notice.role).toBe("system");
    expect(notice.content).toMatch(/no copy/i);
    expect(notice.content).toMatch(/leaves out your own prompts/i);
    expect(notice.content).toMatch(/full history as context/i);
  });

  it("refuses on an engine that cannot load a session", async () => {
    // `loadSession` is the ACP SPEC capability. Adopting without it would mint
    // a conversation whose every send is guaranteed to fail.
    acpCapabilitiesMock.mockResolvedValue({ ...engineCaps(), loadSession: false });
    const useAgentTaskStore = await seededStore();

    await expect(useAgentTaskStore.getState().adoptEngineSession("eng-1")).resolves.toBeNull();
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
  });

  it("refuses a row the directory does not have", async () => {
    const useAgentTaskStore = await seededStore();

    await expect(useAgentTaskStore.getState().adoptEngineSession("eng-nope")).resolves.toBeNull();
    expect(useAgentTaskStore.getState().conversations).toHaveLength(0);
  });

  it("re-opens the existing conversation rather than binding a second one", async () => {
    const useAgentTaskStore = await seededStore();

    const first = await useAgentTaskStore.getState().adoptEngineSession("eng-1");
    useAgentTaskStore.setState({ selectedConversationId: null });
    const second = await useAgentTaskStore.getState().adoptEngineSession("eng-1");

    expect(second).toBe(first);
    expect(useAgentTaskStore.getState().conversations).toHaveLength(1);
    expect(useAgentTaskStore.getState().selectedConversationId).toBe(first);
  });

  it("resumes the bound session instead of minting a new one", async () => {
    const useAgentTaskStore = await seededStore();
    const id = await useAgentTaskStore.getState().adoptEngineSession("eng-1");
    startApiAgentSessionMock.mockClear();

    await useAgentTaskStore.getState().resumeApiConversation(id, "carry on");

    expect(startApiAgentSessionMock).toHaveBeenCalled();
    // The ACP options object is the last positional argument; `engineSessionId`
    // is what makes the backend answer with `session/load`.
    const args = startApiAgentSessionMock.mock.calls[0];
    expect(args[args.length - 1]).toMatchObject({ engineSessionId: "eng-1" });
  });

  it("does not claim the engine forgot a history it is about to reload", async () => {
    const useAgentTaskStore = await seededStore();
    const id = await useAgentTaskStore.getState().adoptEngineSession("eng-1");

    await useAgentTaskStore.getState().resumeApiConversation(id, "carry on");

    const conversation = useAgentTaskStore.getState().conversations.find((c) => c.id === id);
    const notices = conversation.messages.filter((m) => m.role === "system");
    // Only the adoption notice. The "new engine session, context is empty"
    // line would be false here: `session/load` brings the history back.
    expect(notices).toHaveLength(1);
    expect(notices[0].content).not.toMatch(/does not carry the earlier turns/);
  });

  it("keeps the engine-MCP inheritance off unless it was granted", async () => {
    const useAgentTaskStore = await seededStore();
    const id = await useAgentTaskStore.getState().adoptEngineSession("eng-1");
    startApiAgentSessionMock.mockClear();

    await useAgentTaskStore.getState().resumeApiConversation(id, "carry on");

    const args = startApiAgentSessionMock.mock.calls[0];
    expect(args[args.length - 1]).toMatchObject({ inheritEngineMcp: false });
  });

  it("carries an affirmative engine-MCP consent onto the session", async () => {
    const useAgentTaskStore = await seededStore();
    const id = await useAgentTaskStore.getState().adoptEngineSession("eng-1");
    useAgentTaskStore.getState().setAcpInheritEngineMcp(true);
    startApiAgentSessionMock.mockClear();

    await useAgentTaskStore.getState().resumeApiConversation(id, "carry on");

    const args = startApiAgentSessionMock.mock.calls[0];
    expect(args[args.length - 1]).toMatchObject({ inheritEngineMcp: true });
  });
});
