/**
 * agentCapabilities — the ONE place chrome asks "can this session do X?".
 *
 * The contract these assertions defend is not "the fields have nice values",
 * it is **the initial implementation reproduces today's behavior exactly**.
 * Each block therefore names the surface whose old inline branch the field
 * replaced, so a future widening is a deliberate edit here rather than a
 * silent behavior change somewhere in the Agents pane.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  saveServersSlice: vi.fn(),
}));

import {
  capabilitiesFor,
  type CapabilityConversation,
} from "@/lib/agentCapabilities";
import {
  MODE_ORDER,
  SANDBOX_MODE_ORDER,
  modesForApprovals,
} from "@/components/agents/agentModeChipUtils";
import { getProviderForAgent, providerSupportsApprovals } from "@/lib/api-models";
import type { AcpEngineCapabilities, AcpPacketcodeCapabilities } from "@/lib/tauri";

function conv(over: Partial<CapabilityConversation> = {}): CapabilityConversation {
  return {
    agent: "api-claude",
    mode: "api",
    model: "claude-opus-4-8",
    projectPath: "/repo",
    ...over,
  };
}

/**
 * An engine record with EVERYTHING advertised, so each test below can turn
 * exactly one flag off and prove that flag is what moved. The permission list
 * is the full ACP ladder — the state a pre-capability engine is parsed into —
 * so the base fixture changes nothing on its own.
 */
function engineCaps(
  over: Partial<AcpPacketcodeCapabilities> = {},
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
      mcpList: true,
      mcpDefaults: true,
      permissionModes: ["ask", "accept-edits", "auto", "read-only", "bypass"],
      defaultPermissionMode: null,
      ...over,
    },
  };
}

/** An ACP conversation carrying an engine record. */
function acpConv(
  packetcode: Partial<AcpPacketcodeCapabilities> = {},
  over: Partial<CapabilityConversation> = {},
): CapabilityConversation {
  return conv({
    agent: "api-packetcode",
    engineCapabilities: engineCaps(packetcode),
    ...over,
  });
}

describe("capabilitiesFor — permission & safety", () => {
  it("offers the full five-posture set for approval-capable providers", () => {
    const caps = capabilitiesFor(conv());
    expect(caps.canApprovePerTool).toBe(true);
    expect(caps.permissionModes).toEqual(MODE_ORDER);
    expect(caps.permissionVocabulary).toBe("approval");
  });

  it("falls back to the sandbox postures when the adapter cannot pause", () => {
    // No live catalog row sets `supportsApprovals: false`, so this drives the
    // machinery directly to prove the descriptor forwards it rather than
    // hard-coding the approval answer.
    const caps = capabilitiesFor(conv());
    expect(caps.permissionModes).not.toEqual(SANDBOX_MODE_ORDER);
    expect(SANDBOX_MODE_ORDER.every((m) => MODE_ORDER.includes(m))).toBe(true);
  });

  it("gives a PTY session no postures, no write gate and no plan mode", () => {
    const caps = capabilitiesFor(conv({ mode: "pty", agent: "claude-code" }));
    expect(caps.permissionModes).toEqual([]);
    expect(caps.canGateWrites).toBe(false);
    expect(caps.canPlanMode).toBe(false);
  });

  it("does not sandbox-relabel a retired provider id", () => {
    // `api-openai-codex` has no catalog row, so it defaults to approval-capable
    // — the same answer AgentModeChip produced inline.
    const caps = capabilitiesFor(conv({ agent: "api-openai-codex" }));
    expect(caps.permissionVocabulary).toBe("approval");
  });
});

describe("capabilitiesFor — model & inference", () => {
  it("exposes the provider catalog rows as the pickable model set", () => {
    const caps = capabilitiesFor(conv({ agent: "api-openai" }));
    expect(caps.models.length).toBeGreaterThan(0);
    expect(caps.models.map((m) => m.value)).toContain("gpt-5.5");
  });

  it("returns an empty model set for an agent with no catalog row", () => {
    // ModelSelector rendered nothing in this case, so "no picker" is today's
    // behavior — the caller degrades to a read-only model name.
    expect(capabilitiesFor(conv({ agent: "claude-code", mode: "pty" })).models).toEqual([]);
  });

  it("advertises no effort levels — no adapter exposes one yet", () => {
    expect(capabilitiesFor(conv()).effortLevels).toBeNull();
  });

  it("marks only the Claude rows as emitting structured plan blocks", () => {
    expect(capabilitiesFor(conv({ agent: "api-claude" })).structuredPlans).toBe(true);
    expect(capabilitiesFor(conv({ agent: "api-claude-oauth" })).structuredPlans).toBe(true);
    expect(capabilitiesFor(conv({ agent: "api-openai" })).structuredPlans).toBe(false);
    expect(capabilitiesFor(conv({ agent: "api-ollama" })).structuredPlans).toBe(false);
  });

  it("ties thinking and structured edits to api sessions", () => {
    expect(capabilitiesFor(conv()).emitsThinking).toBe(true);
    expect(capabilitiesFor(conv()).structuredEdits).toBe(true);
    const pty = capabilitiesFor(conv({ mode: "pty", agent: "claude-code" }));
    expect(pty.emitsThinking).toBe(false);
    expect(pty.structuredEdits).toBe(false);
  });
});

describe("capabilitiesFor — composer inputs", () => {
  it("offers file mentions only when there is a project to scan", () => {
    expect(capabilitiesFor(conv()).fileMentions).toBe(true);
    expect(capabilitiesFor(conv({ projectPath: "" })).fileMentions).toBe(false);
  });

  it("keeps slash commands, attachments, cancel and queueing unconditional", () => {
    const caps = capabilitiesFor(conv({ mode: "pty", agent: "claude-code" }));
    expect(caps.slashCommands).toBe(true);
    expect(caps.imageAttachments).toBe(true);
    expect(caps.canCancelTurn).toBe(true);
    expect(caps.canQueueWhileStreaming).toBe(true);
  });
});

describe("capabilitiesFor — context & accounting", () => {
  it("resolves the model's context window through the shared helper", () => {
    expect(capabilitiesFor(conv({ model: "claude-opus-4-8" })).contextWindow).toBe(
      1_000_000,
    );
    // Unknown ids still resolve to the directional default — the ring renders.
    expect(capabilitiesFor(conv({ model: "who-knows" })).contextWindow).toBe(200_000);
  });

  it("reports usage for api sessions only", () => {
    expect(capabilitiesFor(conv()).reportsUsage).toBe(true);
    expect(
      capabilitiesFor(conv({ mode: "pty", agent: "claude-code" })).reportsUsage,
    ).toBe(false);
  });

  it("reports cost only for models with published rates", () => {
    expect(capabilitiesFor(conv({ model: "claude-opus-4-8" })).reportsCost).toBe(true);
    // A local Ollama tag has no entry in shared/model-pricing.json, so a dollar
    // figure would be a fiction.
    expect(
      capabilitiesFor(conv({ agent: "api-ollama", model: "llama3.3:70b" })).reportsCost,
    ).toBe(false);
  });
});

describe("capabilitiesFor — environment", () => {
  it("detects a remote session from its ssh target", () => {
    expect(capabilitiesFor(conv()).remote).toBe(false);
    expect(
      capabilitiesFor(
        conv({
          sshTarget: {
            id: "srv-1",
            name: "box",
            host: "10.0.0.2",
            user: "ian",
            remotePath: "/srv/repo",
          },
        }),
      ).remote,
    ).toBe(true);
  });

  it("reports MCP only when sources or read errors were recorded", () => {
    expect(capabilitiesFor(conv()).mcp).toBe(false);
    expect(
      capabilitiesFor(conv({ mcpSources: { sources: [], readErrors: [] } })).mcp,
    ).toBe(false);
    expect(
      capabilitiesFor(
        conv({
          mcpSources: {
            sources: [{ name: "fs", transport: "stdio", scope: "project" }],
            readErrors: [],
          },
        }),
      ).mcp,
    ).toBe(true);
    expect(
      capabilitiesFor(
        conv({
          mcpSources: {
            sources: [],
            readErrors: [{ scope: "global", path: "/x.json", message: "bad" }],
          },
        }),
      ).mcp,
    ).toBe(true);
  });

  it("keeps the auth badge on every api-* id, including retired ones", () => {
    // This IS the `agent.startsWith("api-")` branch AgentHeaderBadges carried.
    // A stored conversation on the retired Codex id must not lose its badge,
    // which is why this does not go through the provider catalog.
    expect(capabilitiesFor(conv({ agent: "api-openai-codex" })).usesProviderCredential)
      .toBe(true);
    expect(capabilitiesFor(conv({ agent: "api-packetcode" })).usesProviderCredential)
      .toBe(true);
    expect(
      capabilitiesFor(conv({ agent: "claude-code", mode: "pty" }))
        .usesProviderCredential,
    ).toBe(false);
  });
});

/**
 * The ACP transport is the first one that can TELL us what it supports. These
 * blocks defend both halves of that: the engine's answer is honoured when it
 * is there, and its ABSENCE changes nothing for anyone else.
 */
describe("capabilitiesFor — engine capabilities (ACP)", () => {
  it("offers only the postures the engine's advertised modes cover", () => {
    // The real engine advertises exactly this pair. PacketBench's postures map
    // onto ACP via `to_acp_permission_mode` (routing.rs): default→auto,
    // plan→read-only, manual→ask, deny→read-only, yolo→bypass. `default`
    // (auto) and `yolo` (bypass) are dropped because session/new would refuse
    // them; `deny` is dropped because it collides with `plan` on `read-only`.
    const caps = capabilitiesFor(acpConv({ permissionModes: ["ask", "read-only"] }));
    expect(caps.permissionModes).toEqual(["plan", "manual"]);
    // Cycle order is preserved — the filter never reorders MODE_ORDER.
    expect(caps.permissionModes).toEqual(
      MODE_ORDER.filter((m) => caps.permissionModes.includes(m)),
    );
  });

  it("keeps every representable posture when the engine advertises the whole ladder", () => {
    // Nothing is EXCLUDED here — but `deny` still goes, because it is never
    // distinct from `plan` on ACP however permissive the engine is. The
    // collision is a property of the mapping, not of the engine's ceiling.
    expect(capabilitiesFor(acpConv()).permissionModes).toEqual([
      "default",
      "plan",
      "manual",
      "yolo",
    ]);
  });

  it("drops a posture whose ACP mode the engine withheld, one at a time", () => {
    expect(capabilitiesFor(acpConv({ permissionModes: ["auto"] })).permissionModes).toEqual([
      "default",
    ]);
    expect(capabilitiesFor(acpConv({ permissionModes: ["bypass"] })).permissionModes).toEqual([
      "yolo",
    ]);
  });

  it("collapses `plan` and `deny` onto the single `read-only` rung", () => {
    // Both map to `read-only`, so offering both would put two rows in the
    // popover that do byte-identical things. `plan` — "read-only exploration"
    // — is the honest reading of that rung; PacketBench's `deny` means "auto-
    // refuse each risky tool and let the agent see the denial", which is NOT
    // what the engine does under `read-only`. Earliest-in-cycle-order wins.
    expect(
      capabilitiesFor(acpConv({ permissionModes: ["read-only"] })).permissionModes,
    ).toEqual(["plan"]);
    expect(
      capabilitiesFor(acpConv({ permissionModes: ["ask", "read-only", "bypass"] }))
        .permissionModes,
    ).toEqual(["plan", "manual", "yolo"]);
  });

  it("NEVER returns an empty posture set", () => {
    // Composer mounts the mode chip on `permissionModes.length > 0`, so an
    // empty array does not restrict the safety control — it deletes it from
    // the composer entirely. An engine whose advertised set covers none of
    // our postures has said something we cannot represent; that is the
    // unknown case, and unknown is not restricted.
    //
    // `accept-edits` is the live example: it belongs to the orthogonal
    // approve-writes flag, not to any posture.
    expect(
      capabilitiesFor(acpConv({ permissionModes: ["accept-edits"] })).permissionModes,
    ).toEqual(MODE_ORDER);
    expect(
      capabilitiesFor(acpConv({ permissionModes: ["something-newer"] })).permissionModes,
    ).toEqual(MODE_ORDER);
    // And the invariant itself, over every subset of the ACP ladder.
    const ladder = ["ask", "accept-edits", "auto", "read-only", "bypass"];
    for (let mask = 0; mask < 1 << ladder.length; mask += 1) {
      const advertised = ladder.filter((_, i) => mask & (1 << i));
      const modes = capabilitiesFor(
        acpConv({ permissionModes: advertised }),
      ).permissionModes;
      expect(modes.length, `advertised: [${advertised.join(", ")}]`).toBeGreaterThan(0);
    }
  });

  it("treats an empty advertised mode list as 'the engine did not say'", () => {
    // Rust guarantees a non-empty list (an absent/garbage one falls back to
    // all five), so an empty array is a malformed payload rather than a
    // statement — and a malformed payload must not silently delete the chip.
    expect(capabilitiesFor(acpConv({ permissionModes: [] })).permissionModes).toEqual(
      MODE_ORDER,
    );
  });

  it("names the engine's default posture only when we cannot represent it", () => {
    // `read-only` is reachable from both `plan` and `deny`, so no single
    // PacketBench posture can honestly be shown as the current one. The engine's
    // own vocabulary is carried verbatim; guessing "ask" is what the Rust DTO
    // explicitly forbids.
    expect(
      capabilitiesFor(acpConv({ defaultPermissionMode: "read-only" }))
        .providerDefaultModeLabel,
    ).toBe("read-only");
    // `accept-edits` belongs to no posture at all — equally unrepresentable.
    expect(
      capabilitiesFor(acpConv({ defaultPermissionMode: "accept-edits" }))
        .providerDefaultModeLabel,
    ).toBe("accept-edits");
    // These three ARE 1:1 with a posture, so the chip labels them itself.
    for (const mode of ["auto", "ask", "bypass"]) {
      expect(
        capabilitiesFor(acpConv({ defaultPermissionMode: mode }))
          .providerDefaultModeLabel,
      ).toBeNull();
    }
    // Engine said nothing.
    expect(
      capabilitiesFor(acpConv({ defaultPermissionMode: null })).providerDefaultModeLabel,
    ).toBeNull();
  });

  it("prefers the engine's enumerated models over the seeded catalog", () => {
    const caps = capabilitiesFor(
      acpConv({}, {
        engineModels: [
          { provider: "anthropic", model: "claude-opus-4-8", default: true },
          { provider: "openai", model: "gpt-5.5", default: false },
        ],
      }),
    );
    expect(caps.models.map((m) => m.value)).toEqual(["claude-opus-4-8", "gpt-5.5"]);
    // Context and price come from the same shared helpers api-models.ts uses.
    expect(caps.models[0].contextWindow).toBe(1_000_000);
    expect(caps.models[0].pricing).toBeDefined();
  });

  it("honours an engine that enumerates NO models", () => {
    // `modelsList` advertised plus an empty answer is a real "I serve none".
    // Falling back to the seeded rows here would put ids in the picker the
    // engine may refuse — the silent no-op this descriptor exists to prevent.
    expect(capabilitiesFor(acpConv({}, { engineModels: [] })).models).toEqual([]);
  });

  it("keeps the seeded catalog when the engine cannot enumerate models", () => {
    const seeded = getProviderForAgent("api-packetcode")?.models ?? [];
    expect(seeded.length).toBeGreaterThan(0);
    // Flag off: never asked.
    expect(capabilitiesFor(acpConv({ modelsList: false })).models).toEqual(seeded);
    // Flag on but the query failed, so nothing was stamped.
    expect(capabilitiesFor(acpConv({ modelsList: true })).models).toEqual(seeded);
    // Vendor block absent: the flags carry no information at all.
    expect(
      capabilitiesFor(
        acpConv({ advertised: false, modelsList: false }, { engineModels: [] }),
      ).models,
    ).toEqual(seeded);
  });

  it("gates slash commands and file mentions on the vendor block", () => {
    const advertised = capabilitiesFor(acpConv());
    expect(advertised.slashCommands).toBe(true);
    expect(advertised.fileMentions).toBe(true);

    // An engine that sent no `_packetcode` block answers method-not-found for
    // `commands/list` and `project/files`, which the backend degrades to an
    // EMPTY list — an affordance that can only ever open an empty menu.
    const bare = capabilitiesFor(acpConv({ advertised: false }));
    expect(bare.slashCommands).toBe(false);
    expect(bare.fileMentions).toBe(false);
  });

  it("still requires a project path for file mentions", () => {
    expect(capabilitiesFor(acpConv({}, { projectPath: "" })).fileMentions).toBe(false);
  });

  it("reports MCP from the engine's own advertisement", () => {
    expect(capabilitiesFor(acpConv()).mcp).toBe(true);
    // Either half alone is worth disclosing: `mcpList` makes the configured
    // fleet readable, `mcpDefaults` is the promise a session could inherit it.
    expect(capabilitiesFor(acpConv({ mcpDefaults: false })).mcp).toBe(true);
    expect(capabilitiesFor(acpConv({ mcpList: false })).mcp).toBe(true);
    expect(
      capabilitiesFor(acpConv({ mcpList: false, mcpDefaults: false })).mcp,
    ).toBe(false);
  });

  it("gates rename on sessionsRename and usage on sessionsUsage", () => {
    expect(capabilitiesFor(acpConv()).canRename).toBe(true);
    expect(capabilitiesFor(acpConv({ sessionsRename: false })).canRename).toBe(false);
    expect(capabilitiesFor(acpConv()).reportsUsage).toBe(true);
    expect(capabilitiesFor(acpConv({ sessionsUsage: false })).reportsUsage).toBe(false);
  });

  it("leaves every non-engine field alone", () => {
    // The engine record must move exactly the seven fields it speaks to; a
    // regression here would mean a capability quietly acquired an ACP branch.
    const withEngine = capabilitiesFor(acpConv());
    const without = capabilitiesFor(conv({ agent: "api-packetcode" }));
    const engineOwned = new Set([
      "permissionModes",
      "providerDefaultModeLabel",
      "models",
      "slashCommands",
      "fileMentions",
      "mcp",
      "canRename",
      "reportsUsage",
    ]);
    for (const key of Object.keys(without) as (keyof typeof without)[]) {
      if (engineOwned.has(key)) continue;
      expect({ [key]: withEngine[key] }).toEqual({ [key]: without[key] });
    }
  });
});

/**
 * THE regression guard. Every transport that is not ACP — and an ACP session
 * before its engine has answered — carries no `engineCapabilities`, and must
 * come out of `capabilitiesFor` bit-for-bit as it did before the engine record
 * existed. A capability fetch that never happened can never cost a session an
 * affordance.
 */
describe("capabilitiesFor — no engine record keeps today's behavior", () => {
  const transports: [string, Partial<CapabilityConversation>][] = [
    ["sidecar (Claude Agent SDK)", { agent: "api-claude-oauth", mode: "api" }],
    ["sidecar (OpenAI Agents SDK)", { agent: "api-openai-agents", mode: "api" }],
    ["in-process LlmProvider", { agent: "api-openai", mode: "api" }],
    ["in-process (local, unpriced)", { agent: "api-ollama", mode: "api" }],
    ["PTY CLI", { agent: "claude-code", mode: "pty" }],
    ["ACP before the engine answers", { agent: "api-packetcode", mode: "api" }],
  ];

  it.each(transports)("%s", (_label, over) => {
    const conversation = conv(over);
    expect(conversation.engineCapabilities).toBeUndefined();
    const caps = capabilitiesFor(conversation);
    const isApi = conversation.mode === "api";

    // agentModeChipUtils.modesForApprovals, unfiltered.
    expect(caps.permissionModes).toEqual(
      isApi ? modesForApprovals(providerSupportsApprovals(conversation.agent)) : [],
    );
    // No backend has named a default posture, so the chip labels its own.
    expect(caps.providerDefaultModeLabel).toBeNull();
    // api-models.API_PROVIDERS, verbatim.
    expect(caps.models).toEqual(getProviderForAgent(conversation.agent)?.models ?? []);
    // Unconditional true.
    expect(caps.slashCommands).toBe(true);
    // Project-path test only.
    expect(caps.fileMentions).toBe(!!conversation.projectPath);
    // The `mcp_sources` event condition only — no sources here, so false.
    expect(caps.mcp).toBe(false);
    // Unconditional true.
    expect(caps.canRename).toBe(true);
    // `mode === "api"` only.
    expect(caps.reportsUsage).toBe(isApi);
  });

  it("keeps the mcp_sources pill condition intact", () => {
    expect(
      capabilitiesFor(
        conv({
          agent: "api-claude-oauth",
          mcpSources: {
            sources: [{ name: "fs", transport: "stdio", scope: "project" }],
            readErrors: [],
          },
        }),
      ).mcp,
    ).toBe(true);
  });
});
