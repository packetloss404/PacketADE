/**
 * MCP consent for the ACP transport.
 *
 * Four things are defended here, and each one fails in a different direction:
 *
 *  1. **Silence means nothing starts.** `acp_mcp_plan` refuses on absence — no
 *     allowlist or no trust snapshot yields an empty plan, which is
 *     `mcpServers: []` on the wire. The UI must say exactly that and must not
 *     paper over it with an optimistic default, because ACP cannot filter a
 *     tool call after the fact and every included server is a local subprocess.
 *
 *  2. **Every verdict is phrased, none is silent.** A server left out of the
 *     session is shown with the reason it was left out, so "my MCP server
 *     isn't running" is answerable from the surface rather than from a log.
 *
 *  3. **One consent model.** Allowing a server writes to `mcpTrustStore` and
 *     `agentSettingsStore` — the same pair `captureMcpTrustSnapshot` freezes
 *     onto a conversation for every transport. There is deliberately no
 *     ACP-only consent record to diverge from.
 *
 *  4. **A refused inheritance is said out loud.** Consent to the engine's own
 *     fleet against an engine that never advertised `mcpDefaults` is dropped
 *     by the backend; showing the consent as if it had taken effect would be a
 *     quiet lie about what is running.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The component pulls in the real `agentTaskStore` graph for the
// inherit-consent slice; that cold import costs seconds on Windows under
// parallel suite load.
vi.setConfig({ testTimeout: 30_000 });

const acpMcpPlanMock = vi.fn();
const acpListMcpServersMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

// Partial mock: only the two engine queries are stubbed, so a rename or
// removal anywhere else in `lib/tauri` still fails loudly here.
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  acpMcpPlan: (...args: unknown[]) => acpMcpPlanMock(...args),
  acpListMcpServers: (...args: unknown[]) => acpListMcpServersMock(...args),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
}));

import { AcpMcpConsent } from "@/components/agents/AcpMcpConsent";
import { capabilitiesFor } from "@/lib/agentCapabilities";
import { engineDirectoryRecord, useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAgentSettingsStore } from "@/stores/agentSettingsStore";
import { useMcpStore } from "@/stores/mcpStore";
import { useMcpTrustStore } from "@/stores/mcpTrustStore";
import type {
  AcpEngineCapabilities,
  AcpMcpPlan,
  AcpMcpPlannedServer,
  AcpMcpReason,
} from "@/lib/tauri";
import type { McpServerEntry } from "@/types/mcp";

const PROJECT = "D:/projects/example";

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

function caps(engine: AcpEngineCapabilities | null) {
  return capabilitiesFor(engineDirectoryRecord(engine));
}

function candidate(over: Partial<AcpMcpPlannedServer> = {}): AcpMcpPlannedServer {
  return {
    name: "github",
    scope: "global",
    transport: "stdio",
    command: "gh-mcp",
    args: [],
    included: false,
    reason: "noTrustDecision",
    unenforced: [],
    ...over,
  };
}

function plan(over: Partial<AcpMcpPlan> = {}): AcpMcpPlan {
  return {
    posture: "none",
    servers: [candidate()],
    selected: [],
    inheritRefused: false,
    ...over,
  };
}

function serverEntry(over: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: "github",
    config: { command: "gh-mcp", args: [] },
    scope: "global",
    disabled: false,
    ...over,
  };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: /mcp for new sessions/i }));
}

function renderConsent(engine: AcpEngineCapabilities | null = engineCaps(), project = PROJECT) {
  return render(<AcpMcpConsent projectPath={project} caps={caps(engine)} />);
}

describe("AcpMcpConsent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    acpMcpPlanMock.mockResolvedValue(plan());
    acpListMcpServersMock.mockResolvedValue([]);
    useMcpStore.setState({
      servers: [serverEntry()],
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
    });
    useMcpTrustStore.setState({ profiles: {}, capabilities: {} });
    useAgentSettingsStore.setState({ defaultEnabledMcpServerIds: null });
    useAgentTaskStore.setState({ acpInheritEngineMcp: false });
  });

  it("is absent where the descriptor says there is nothing to disclose", () => {
    // `caps.mcp` is false when no fleet was sourced and the engine advertised
    // neither `mcpList` nor `mcpDefaults`. The gate is the descriptor, not the
    // provider id.
    renderConsent(engineCaps({ mcpList: false, mcpDefaults: false }));
    expect(screen.queryByText(/mcp for new sessions/i)).not.toBeInTheDocument();
  });

  it("asks the backend nothing until the user opens it", () => {
    renderConsent();
    expect(acpMcpPlanMock).not.toHaveBeenCalled();
  });

  it("says plainly that no servers start when nothing has been decided", async () => {
    renderConsent();
    open();

    await waitFor(() => expect(acpMcpPlanMock).toHaveBeenCalled());
    // The default posture, stated rather than implied by an empty list.
    expect(await screen.findByText(/No MCP servers will start/i)).toBeInTheDocument();
    // And the server that is NOT running is still shown, with its reason.
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText(/No decision recorded yet/i)).toBeInTheDocument();
  });

  it("forwards the decision it previews, never a permissive stand-in", async () => {
    renderConsent();
    open();

    await waitFor(() => expect(acpMcpPlanMock).toHaveBeenCalled());
    const sent = acpMcpPlanMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.projectPath).toBe(PROJECT);
    // An EMPTY snapshot is a real answer and must travel as one: `null` would
    // be indistinguishable from "we never asked", and the backend treats both
    // as refusal — but only one of them is honest about what was captured.
    expect(Array.isArray(sent.mcpTrustSnapshot)).toBe(true);
    expect(sent.inheritEngineDefaults).toBe(false);
  });

  it("phrases every admission verdict", async () => {
    const reasons: Array<[AcpMcpReason, RegExp]> = [
      ["trusted", /Allowed — this server will start/i],
      ["disabled", /Disabled in MCP settings/i],
      ["noTrustDecision", /No decision recorded yet/i],
      ["notSelected", /Not allowed for agent sessions/i],
      ["noSnapshotForServer", /no trust record was captured/i],
      ["trustDeniesServer", /trust profile withholds reads/i],
      ["unsupportedTransport", /stdio servers only/i],
      ["commandNotResolvable", /could not be resolved to an executable/i],
    ];
    acpMcpPlanMock.mockResolvedValue(
      plan({
        servers: reasons.map(([reason], index) =>
          candidate({
            name: `server-${index}`,
            reason,
            included: reason === "trusted",
          }),
        ),
        selected: ["server-0"],
      }),
    );

    renderConsent();
    open();

    // The summary line also names the selected server, so wait on a phrase
    // that appears exactly once instead of on the server name.
    await screen.findByText(/Allowed — this server will start/i);
    for (const [reason, copy] of reasons) {
      expect(screen.getByText(copy), `no copy for ${reason}`).toBeInTheDocument();
    }
  });

  it("offers Allow only where consent is what is missing", async () => {
    // A disabled server, an http one, and one whose command cannot be resolved
    // are facts about the configuration. An Allow button on them would be a
    // control that cannot take effect.
    acpMcpPlanMock.mockResolvedValue(
      plan({
        servers: [
          candidate({ name: "fixable", reason: "notSelected" }),
          candidate({ name: "off", reason: "disabled" }),
          candidate({ name: "remote", reason: "unsupportedTransport", transport: "http" }),
        ],
      }),
    );
    useMcpStore.setState({
      servers: [
        serverEntry({ name: "fixable" }),
        serverEntry({ name: "off", disabled: true }),
        serverEntry({ name: "remote" }),
      ],
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
    });

    renderConsent();
    open();

    await screen.findByText("fixable");
    expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);
  });

  it("writes an Allow into the shared trust model, not a private one", async () => {
    acpMcpPlanMock.mockResolvedValue(
      plan({ servers: [candidate({ reason: "notSelected" })] }),
    );
    renderConsent();
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));

    // Both halves of the model every transport already reads: the allowlist
    // `captureMcpTrustSnapshot` filters on, and the per-server profile it
    // freezes. `null` (all enabled) is materialized into an explicit naming —
    // the same set as before, but now something ACP can actually send.
    expect(useAgentSettingsStore.getState().defaultEnabledMcpServerIds).toEqual(["github"]);
    expect(useMcpTrustStore.getState().profiles["global:github"]?.allowReads).toBe(true);
  });

  it("turns a Don't allow into a withheld read, not just a hidden row", async () => {
    acpMcpPlanMock.mockResolvedValue(
      plan({
        servers: [candidate({ included: true, reason: "trusted" })],
        selected: ["github"],
        posture: "explicit",
      }),
    );
    useAgentSettingsStore.setState({ defaultEnabledMcpServerIds: ["github"] });

    renderConsent();
    open();

    const revoke = await screen.findByRole("button", { name: /Don't allow/i });
    fireEvent.click(revoke);

    expect(useAgentSettingsStore.getState().defaultEnabledMcpServerIds).toEqual([]);
    expect(useMcpTrustStore.getState().profiles["global:github"]?.allowReads).toBe(false);
  });

  it("surfaces a refused inheritance instead of showing consent that did nothing", async () => {
    acpMcpPlanMock.mockResolvedValue(plan({ inheritRefused: true }));
    useAgentTaskStore.setState({ acpInheritEngineMcp: true });

    renderConsent();
    open();

    expect(await screen.findByText(/never advertised that it understands/i)).toBeInTheDocument();
    expect(screen.getByText(/No MCP servers will start/i)).toBeInTheDocument();
  });

  it("degrades to a refusal when the plan cannot be computed", async () => {
    acpMcpPlanMock.mockRejectedValue(new Error("engine gone"));
    renderConsent();
    open();

    // Never throws into render, and never claims something will run.
    expect(
      await screen.findByText(/A session started now would run no MCP servers/i),
    ).toBeInTheDocument();
  });

  it("asks for the engine's own fleet only when that section is opened", async () => {
    renderConsent();
    open();
    await waitFor(() => expect(acpMcpPlanMock).toHaveBeenCalled());
    expect(acpListMcpServersMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /the engine's own servers/i }));

    await waitFor(() => expect(acpListMcpServersMock).toHaveBeenCalledWith(null));
  });

  it("keeps the engine-fleet consent off until it is granted", async () => {
    renderConsent();
    open();
    await waitFor(() => expect(acpMcpPlanMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /the engine's own servers/i }));

    const toggle = await screen.findByRole("checkbox");
    expect(toggle).not.toBeChecked();
    expect(useAgentTaskStore.getState().acpInheritEngineMcp).toBe(false);

    fireEvent.click(toggle);
    expect(useAgentTaskStore.getState().acpInheritEngineMcp).toBe(true);
  });

it("names the trust settings packetcode will not apply to a running server", async () => {
    // FAULT: the MCP Hub's per-tool allowlist, read-only posture, workspace
    // roots and denial floors are all enforced at tool-call time on the
    // sidecar and NONE of them cross the ACP boundary — the engine owns the
    // MCP client. Presenting both as the same guarantee is the dishonesty.
    // It is not fixable on this transport, so it must be said out loud.
    acpMcpPlanMock.mockResolvedValue(
      plan({
        posture: "explicit",
        selected: ["github"],
        servers: [
          candidate({
            included: true,
            reason: "trusted",
            unenforced: ["toolAllowlist", "readOnly", "workspaceRoots", "denialFloors"],
          }),
        ],
      }),
    );
    renderConsent();
    open();

    expect(await screen.findByText(/Not enforced here/i)).toBeInTheDocument();
    // Specific, not a vague caveat — each lapsed setting is named.
    expect(screen.getByText(/per-tool allowlist/i)).toBeInTheDocument();
    expect(screen.getByText(/may call tools that write/i)).toBeInTheDocument();
    expect(screen.getByText(/workspace-root limit/i)).toBeInTheDocument();
    expect(screen.getByText(/denial floors/i)).toBeInTheDocument();
    // ...and it says the settings are not worthless, just not applied HERE.
    expect(screen.getByText(/still hold on the other agent transports/i)).toBeInTheDocument();
  });

  it("says nothing about unenforced trust for a server that will not run", async () => {
    // A server nothing starts exercises no authority, so the notice must not
    // appear on it — otherwise it becomes wallpaper and stops being read.
    acpMcpPlanMock.mockResolvedValue(
      plan({ servers: [candidate({ included: false, reason: "notSelected" })] }),
    );
    renderConsent();
    open();

    await waitFor(() => expect(acpMcpPlanMock).toHaveBeenCalled());
    expect(screen.queryByText(/Not enforced here/i)).not.toBeInTheDocument();
  });

  it("states the transport-level limit even before a server is allowed", async () => {
    renderConsent();
    open();

    await waitFor(() => expect(acpMcpPlanMock).toHaveBeenCalled());
    expect(
      screen.getByText(/ONLY MCP limit packetcode can enforce/i),
    ).toBeInTheDocument();
  });

  it("does not show a plan for a project nobody chose", () => {
    renderConsent(engineCaps(), "");
    open();
    expect(acpMcpPlanMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Open a project/i)).toBeInTheDocument();
  });
});
