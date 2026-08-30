/**
 * ACP capability stamping — how the engine's advertised capabilities reach
 * the conversation record.
 *
 * `capabilitiesFor()` is a PURE function of the conversation, so the ONLY way
 * the descriptor can honour what the engine said is for the answer to be on
 * the record. `stampEngineCapabilities` is what puts it there, and these
 * assertions defend the two properties that make it safe to do at all:
 *
 *  1. it touches nothing but `packetcode-acp` conversations, and
 *  2. every failure mode leaves the record WITHOUT an engine block — which
 *     `capabilitiesFor` reads as "nobody told us anything" and answers with
 *     the pre-ACP behavior. A capability fetch must never fail a session
 *     start, and must never cost a session an affordance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const acpCapabilitiesMock = vi.fn();
const acpListModelsMock = vi.fn();
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

// Partial mock: only the calls this file drives are stubbed. Everything else
// keeps its real binding (over the mocked `invoke`), so a rename or removal in
// `lib/tauri` still fails loudly here instead of being papered over.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
  acpCapabilities: (...args: unknown[]) => acpCapabilitiesMock(...args),
  acpListModels: (...args: unknown[]) => acpListModelsMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
}));

import type { AcpEngineCapabilities } from "@/lib/tauri";

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
      modelsList: true,
      commandsList: null,
      projectFiles: null,
      mcpList: true,
      mcpDefaults: true,
      // What the live engine actually advertises.
      permissionModes: ["ask", "read-only"],
      defaultPermissionMode: "read-only",
      ...over,
    },
  };
}

async function startAcpConversation(): Promise<string> {
  const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
  return useAgentTaskStore.getState().createApiConversation({
    agent: "api-packetcode",
    projectPath: "D:/projects/example",
    model: "claude-opus-4-8",
    initialMessage: "kickoff",
  });
}

async function conversationById(id: string) {
  const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
  return useAgentTaskStore.getState().conversations.find((c) => c.id === id);
}

describe("agentTaskStore — ACP engine capability stamping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    startApiAgentSessionMock.mockResolvedValue(undefined);
    acpCapabilitiesMock.mockResolvedValue(engineCaps());
    acpListModelsMock.mockResolvedValue([
      { provider: "anthropic", model: "claude-opus-4-8", default: true },
    ]);
  });

  it("stamps the engine's capabilities and models onto an ACP conversation", async () => {
    const id = await startAcpConversation();

    // Un-awaited by the launch path, so the record fills in once the engine
    // answers — never before the first turn is on its way.
    await vi.waitFor(async () => {
      expect((await conversationById(id))?.engineCapabilities).toBeDefined();
    });

    const conversation = await conversationById(id);
    expect(conversation?.engineCapabilities?.packetcode.permissionModes).toEqual([
      "ask",
      "read-only",
    ]);
    expect(conversation?.engineModels).toEqual([
      { provider: "anthropic", model: "claude-opus-4-8", default: true },
    ]);
  });

  it("restricts the descriptor's postures once the engine has answered", async () => {
    // The end-to-end point of the whole stamping path: the mode chip stops
    // offering `default` (auto) and `yolo` (bypass), which this engine's
    // session/new would refuse, and `deny`, which collides with `plan` on the
    // single `read-only` rung.
    const id = await startAcpConversation();
    await vi.waitFor(async () => {
      expect((await conversationById(id))?.engineCapabilities).toBeDefined();
    });

    const { capabilitiesFor } = await import("@/lib/agentCapabilities");
    const conversation = await conversationById(id);
    const caps = capabilitiesFor(conversation!);
    expect(caps.permissionModes).toEqual(["plan", "manual"]);
    // The engine's default (`read-only`) is reachable from two postures, so
    // the chip must not claim the session is in either of them.
    expect(caps.providerDefaultModeLabel).toBe("read-only");
  });

  it("never asks the engine about a non-ACP conversation", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const id = await useAgentTaskStore.getState().createApiConversation({
      agent: "api-openai",
      projectPath: "D:/projects/example",
      model: "gpt-4o",
      initialMessage: "kickoff",
    });

    expect(acpCapabilitiesMock).not.toHaveBeenCalled();
    expect((await conversationById(id))?.engineCapabilities).toBeUndefined();
    expect((await conversationById(id))?.engineModels).toBeUndefined();
  });

  it("survives a failed capability fetch without failing the session", async () => {
    acpCapabilitiesMock.mockRejectedValue(new Error("engine not started"));

    const id = await startAcpConversation();
    const conversation = await conversationById(id);

    // The session exists, is live, and simply carries no engine block.
    expect(conversation).toBeDefined();
    expect(conversation?.status).not.toBe("failed");
    expect(conversation?.engineCapabilities).toBeUndefined();
    // Which is exactly the pre-ACP answer — no affordance was lost.
    const { capabilitiesFor } = await import("@/lib/agentCapabilities");
    const { MODE_ORDER } = await import("@/components/agents/agentModeChipUtils");
    const caps = capabilitiesFor(conversation!);
    expect(caps.permissionModes).toEqual(MODE_ORDER);
    expect(caps.slashCommands).toBe(true);
    expect(caps.canRename).toBe(true);
  });

  it("does not block session start on a slow capability fetch", async () => {
    let release: ((caps: AcpEngineCapabilities) => void) | undefined;
    acpCapabilitiesMock.mockReturnValue(
      new Promise<AcpEngineCapabilities>((resolve) => {
        release = resolve;
      }),
    );

    // Resolves while the query is still outstanding.
    const id = await startAcpConversation();
    expect(await conversationById(id)).toBeDefined();
    expect((await conversationById(id))?.engineCapabilities).toBeUndefined();

    release?.(engineCaps());
    await vi.waitFor(async () => {
      expect((await conversationById(id))?.engineCapabilities).toBeDefined();
    });
  });

  it("keeps the seeded catalog when the model query fails", async () => {
    acpListModelsMock.mockRejectedValue(new Error("-32603 internal"));

    const id = await startAcpConversation();
    await vi.waitFor(async () => {
      expect((await conversationById(id))?.engineCapabilities).toBeDefined();
    });

    // Capabilities landed; models did not, so the picker keeps the seeded
    // `API_PROVIDERS` rows rather than emptying out.
    const conversation = await conversationById(id);
    expect(conversation?.engineModels).toBeUndefined();
    const { capabilitiesFor } = await import("@/lib/agentCapabilities");
    expect(capabilitiesFor(conversation!).models.length).toBeGreaterThan(0);
  });

  it("does not query models the engine never advertised", async () => {
    acpCapabilitiesMock.mockResolvedValue(engineCaps({ modelsList: false }));

    const id = await startAcpConversation();
    await vi.waitFor(async () => {
      expect((await conversationById(id))?.engineCapabilities).toBeDefined();
    });

    expect(acpListModelsMock).not.toHaveBeenCalled();
    expect((await conversationById(id))?.engineModels).toBeUndefined();
  });

  it("ignores the vendor flags of an engine that advertised nothing", async () => {
    // `advertised: false` means the booleans carry NO information — the
    // backend's call-time method-not-found fallbacks still decide — so the
    // model query must not be attempted on the strength of a stray true.
    acpCapabilitiesMock.mockResolvedValue(
      engineCaps({ advertised: false, modelsList: true }),
    );

    const id = await startAcpConversation();
    await vi.waitFor(async () => {
      expect((await conversationById(id))?.engineCapabilities).toBeDefined();
    });

    expect(acpListModelsMock).not.toHaveBeenCalled();
  });

  it("leaves an unknown conversation id alone", async () => {
    const { stampEngineCapabilities, useAgentTaskStore } = await import(
      "@/stores/agentTaskStore"
    );
    // The conversation the user deleted while the query was in flight.
    await expect(
      stampEngineCapabilities("conv-gone", "packetcode-acp"),
    ).resolves.toBeUndefined();
    expect(useAgentTaskStore.getState().conversations).toEqual([]);
  });
});
