import type { AgentCli } from "@/stores/agentTaskStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { AgentMode } from "@/components/agents/AgentModeChip";
import {
  getProviderForAgent,
  providerSupportsApprovals,
  type ApiModel,
} from "@/lib/api-models";
import { MODE_ORDER, modesForApprovals } from "@/components/agents/agentModeChipUtils";
import { getModelContextWindow } from "@/lib/modelContext";
import { getModelRates } from "@/lib/conversationCost";
import { isRemoteConversation } from "@/lib/remoteConversation";
import type { AcpEngineCapabilities, AcpModelOption } from "@/lib/tauri";

/**
 * THE capability descriptor for an agent session.
 *
 * ## Why this exists
 *
 * Chrome must render from CAPABILITIES, never from provider identity. Before
 * this module, a dozen components each answered "can this session do X?" by
 * asking "is this session `api-claude-oauth`?" — so every new provider needed
 * a sweep through the whole Agents pane, and every miss shipped a control that
 * did nothing (or hid one that would have worked).
 *
 * Identity may still feed LABELS (the provider name on a model chip, the
 * auth-probe key). It may never decide whether a control exists.
 *
 * ## Contract for changing this file
 *
 * The initial implementation returns EXACTLY today's behavior. Where today's
 * behavior *is* an identity check, that identity check is encoded here — once,
 * marked `IDENTITY (widen later)` — rather than being deleted. Moving the
 * branching to one place is the win; changing what it decides is a separate,
 * deliberate step. When a provider gains a capability, widen the field here and
 * every consumer follows for free.
 */
export interface SessionCapabilities {
  // ── permission & safety ────────────────────────────────────────────────
  /** The adapter can pause a tool call and wait for a user decision. */
  canApprovePerTool: boolean;
  /** Postures this session may present, in cycle order. Empty → no mode chip. */
  permissionModes: AgentMode[];
  /** Which wording the postures are labelled with. */
  permissionVocabulary: "approval" | "sandbox";
  /**
   * The backend's OWN name for the posture a session lands on when PacketBench
   * sends no override — set only when that posture has no 1:1 PacketBench
   * equivalent, and `null` everywhere else (including every non-ACP session).
   *
   * This exists because ACP's ladder is not a bijection onto PacketBench's five
   * postures. The live engine defaults to `read-only`, which BOTH `plan` and
   * `deny` map onto, so no single posture can honestly be shown as "what this
   * session is currently doing". `src-tauri/src/acp/mod.rs` is explicit that
   * the UI must not guess — so this carries the engine's vocabulary verbatim
   * (e.g. `"read-only"`) and a chip renders it as a provider-default state
   * rather than pretending it is one of ours.
   *
   * `null` means either "the backend did not say" or "it said something that
   * IS one of our postures", and in both cases the chip names the posture
   * itself exactly as it does today.
   */
  providerDefaultModeLabel: string | null;
  /** The "Approve writes" fine flag is meaningful for this session. */
  canGateWrites: boolean;
  /** Read-only plan mode can be entered. */
  canPlanMode: boolean;

  // ── model & inference ──────────────────────────────────────────────────
  /** Catalog rows this session can switch between. Empty → read-only name. */
  models: ApiModel[];
  /** Reasoning-effort levels the adapter accepts; null → no effort control. */
  effortLevels: string[] | null;
  /** Turns can carry extended-thinking text. */
  emitsThinking: boolean;
  /** The adapter emits structured plan/todo blocks (not a prose heuristic). */
  structuredPlans: boolean;

  // ── tools & edits ──────────────────────────────────────────────────────
  /** Edits arrive as structured pending-edit payloads that can be reviewed. */
  structuredEdits: boolean;
  /** An in-flight turn can be cancelled. */
  canCancelTurn: boolean;
  /** A message typed mid-stream is queued rather than dropped. */
  canQueueWhileStreaming: boolean;

  // ── composer inputs ────────────────────────────────────────────────────
  /** `@` opens a file picker rooted at this session's project. */
  fileMentions: boolean;
  /** `/` opens the slash-command palette. */
  slashCommands: boolean;
  /** Images can be pasted/dropped into the composer. */
  imageAttachments: boolean;

  // ── context & accounting ───────────────────────────────────────────────
  /** Total context window in tokens; null → no ContextUsageRing. */
  contextWindow: number | null;
  /** Turns report token counts (drives the statusline's ctx/in/out). */
  reportsUsage: boolean;
  /** This session's model has published rates, so a $ figure is meaningful. */
  reportsCost: boolean;

  // ── environment ────────────────────────────────────────────────────────
  /** Tools execute on a remote host — the local filesystem is NOT this one. */
  remote: boolean;
  /** MCP servers were sourced for this session (read-only disclosure). */
  mcp: boolean;
  /** The session can be renamed in place. */
  canRename: boolean;
  /** A prior user turn can be edited/retried, forking the conversation. */
  canFork: boolean;
  /**
   * This session authenticates through a provider credential PacketBench holds,
   * so a live auth badge is meaningful. PTY/CLI sessions carry their own login
   * and surface it elsewhere.
   */
  usesProviderCredential: boolean;
}

/**
 * The subset of a conversation capabilities are derived from. Deliberately
 * structural so callers can pass partial/derived records (and tests can pass
 * literals) — same convention as `RemoteAwareConversation`.
 */
export type CapabilityConversation = Pick<
  AgentConversation,
  | "agent"
  | "mode"
  | "model"
  | "projectPath"
  | "sshTarget"
  | "mcpSources"
  | "engineCapabilities"
  | "engineModels"
>;

/**
 * PacketBench posture → ACP permission mode.
 *
 * MIRRORS `to_acp_permission_mode` in `src-tauri/src/acp/routing.rs`, which is
 * the authority — that function is what actually decides which ACP mode a
 * session/new carries, so a disagreement here would offer the user a posture
 * the engine then silently downgrades. Postures reach Rust as a
 * `(planMode, permissionMode)` pair rather than by name, hence the two-step:
 *
 * | posture   | what Rust receives                  | ACP mode      |
 * |-----------|-------------------------------------|---------------|
 * | `default` | `permissionMode = "auto"`           | `auto`        |
 * | `plan`    | `planMode = true`                   | `read-only`   |
 * | `manual`  | `permissionMode = "ask_for_risky"`  | `ask`         |
 * | `deny`    | `permissionMode = "deny_all"`       | `read-only`   |
 * | `yolo`    | `permissionMode = "allow_all"`      | `bypass`      |
 *
 * `accept-edits` has no posture of its own — it is the ACP mode the orthogonal
 * `approveWrites` fine flag maps to — so it never appears here and never
 * keeps or drops a posture on its own.
 */
const ACP_MODE_FOR_POSTURE: Record<AgentMode, string> = {
  default: "auto",
  plan: "read-only",
  manual: "ask",
  deny: "read-only",
  yolo: "bypass",
};

/**
 * Narrow PacketBench's postures to the ones this engine will actually accept.
 *
 * The engine trims its `permissionModes` to the operator's configured ceiling
 * and answers `-32602` for anything above it; Rust's `resolve_permission_mode`
 * then drops the override entirely and the session lands on the engine's own
 * default. So a posture outside the advertised set is not merely risky to
 * offer — picking it does nothing at all, which is precisely the silent no-op
 * this descriptor exists to prevent.
 *
 * Three rules, each of which is a bug if you get it wrong:
 *
 * 1. **Unknown is not restricted.** No engine record (non-ACP transport, or an
 *    ACP session whose capability fetch is still in flight or failed) returns
 *    `postures` untouched. Narrowing on absent data would make the chip flip
 *    from five postures to two on every session start.
 * 2. **Colliding postures collapse to one.** ACP's ladder is not a bijection
 *    onto PacketBench's five: `plan` and `deny` BOTH map to `read-only`. Keeping
 *    both would offer two rows that produce byte-identical engine behavior —
 *    and `deny`'s PacketBench meaning ("every risky tool is auto-refused, the
 *    agent keeps going and sees the denials") is not what `read-only` does
 *    (the engine withholds the mutating tools outright). The earliest posture
 *    in the session's own cycle order wins, which keeps `plan` — the honest
 *    reading of `read-only` — and drops `deny`.
 * 3. **An empty intersection is never returned.** `Composer` mounts the mode
 *    chip on `permissionModes.length > 0`, so an empty array does not restrict
 *    the safety control, it DELETES it. An engine whose advertised set covers
 *    none of our postures has told us something we cannot represent, which is
 *    the unknown case again — fall back to the full set.
 */
function restrictToEngineModes(
  postures: AgentMode[],
  engine: AcpEngineCapabilities | undefined,
): AgentMode[] {
  const advertised = engine?.packetcode.permissionModes;
  if (!Array.isArray(advertised) || advertised.length === 0) return postures;
  const claimed = new Set<string>();
  const offered = postures.filter((posture) => {
    const mode = ACP_MODE_FOR_POSTURE[posture];
    if (!advertised.includes(mode) || claimed.has(mode)) return false;
    claimed.add(mode);
    return true;
  });
  return offered.length > 0 ? offered : postures;
}

/**
 * The engine's own name for its default posture, when we cannot honestly show
 * it as one of ours. See `SessionCapabilities.providerDefaultModeLabel`.
 *
 * "Cannot honestly show" is decided by the reverse of `ACP_MODE_FOR_POSTURE`:
 * an ACP mode reachable from exactly ONE posture names that posture, so the
 * chip labels it normally and this stays `null`. `read-only` (reachable from
 * `plan` and `deny`) and `accept-edits` (reachable from no posture at all)
 * are ambiguous, and guessing one is exactly what the Rust DTO forbids.
 */
function engineDefaultModeLabel(engine: AcpEngineCapabilities | undefined): string | null {
  const advertisedDefault = engine?.packetcode.defaultPermissionMode?.trim();
  if (!advertisedDefault) return null;
  const matches = MODE_ORDER.filter(
    (posture) => ACP_MODE_FOR_POSTURE[posture] === advertisedDefault,
  );
  return matches.length === 1 ? null : advertisedDefault;
}

/**
 * One engine-enumerated model as a picker row. The engine reports a
 * `(provider, model)` pair; PacketBench picks a MODEL and lets the engine
 * resolve the provider that serves it (see `routing.rs::start_session`, which
 * always sends `provider: None`), so the model id is both the label and the
 * value. Context/pricing come from the same shared helpers `api-models.ts`
 * uses, with its zero-rate guard — a free/local model has a 0/0 entry, and
 * "$0.00" is a fiction rather than a price.
 */
function engineModelRow(option: AcpModelOption): ApiModel {
  const rates = getModelRates(option.model);
  const row: ApiModel = {
    label: option.model,
    value: option.model,
    contextWindow: getModelContextWindow(option.model),
  };
  if (rates && (rates.input > 0 || rates.output > 0)) row.pricing = rates;
  return row;
}

/**
 * The engine's model list, or `undefined` to keep the seeded catalog.
 *
 * Gated on the ADVERTISED `modelsList` flag, not on the list being non-empty:
 * an engine that says it enumerates models and then names none has genuinely
 * told us it serves none, and offering the seeded `API_PROVIDERS` rows anyway
 * would put ids in the picker that the engine may refuse. `undefined` (never
 * asked, or the ask failed) is the only case that falls back.
 */
function engineModels(conversation: CapabilityConversation): ApiModel[] | undefined {
  const packetcode = conversation.engineCapabilities?.packetcode;
  if (!packetcode?.advertised || !packetcode.modelsList) return undefined;
  const listed = conversation.engineModels;
  if (!Array.isArray(listed)) return undefined;
  return listed.map(engineModelRow);
}

/**
 * IDENTITY (widen later) — "this session is an API agent, not a PTY CLI".
 *
 * Today this is a prefix test on the `AgentCli` id, which is what
 * `AgentHeaderBadges` did inline. It deliberately does NOT go through the
 * `API_PROVIDERS` catalog: retired ids (`api-openai-codex`) have no catalog
 * row but ARE api sessions, and a stored conversation on one must keep its
 * auth badge. Replace with a real transport/capability flag on the agent
 * record when one exists.
 */
function isApiAgentId(agent: AgentCli): boolean {
  return typeof agent === "string" && agent.startsWith("api-");
}

/**
 * IDENTITY (widen later) — "this adapter emits structured plan blocks".
 *
 * Only the Claude rows stream `api-agent:plan-block:*` TodoWrite payloads
 * today, which is the branch PlanPanel carries inline. Any adapter that starts
 * emitting plan blocks should be added here (or, better, should advertise the
 * capability at session start so this list can go away).
 */
function emitsStructuredPlans(agent: AgentCli): boolean {
  return agent === "api-claude" || agent === "api-claude-oauth";
}

/**
 * "A dollar figure is meaningful for this model." Mirrors the guard
 * `api-models.ts` applies when it populates `ApiModel.pricing`: an entry of
 * 0/0 (Ollama, free tiers) is a real row, but not a real price.
 */
function hasMeaningfulRates(model: string | undefined): boolean {
  const rates = getModelRates(model);
  return !!rates && (rates.input > 0 || rates.output > 0);
}

/**
 * Resolve what a session can do. Pure — no store reads, no IPC — so every
 * consumer can call it during render without a subscription.
 */
export function capabilitiesFor(
  conversation: CapabilityConversation,
): SessionCapabilities {
  const agent = conversation.agent;
  const isApi = conversation.mode === "api";
  const canApprovePerTool = providerSupportsApprovals(agent);
  const mcpSources = conversation.mcpSources;
  /**
   * What the ACP engine advertised for THIS conversation, or `undefined` for
   * every other transport (sidecar, in-process, PTY) — and for an ACP session
   * whose capability fetch failed.
   *
   * `undefined` is the load-bearing case: every field below must fall through
   * to its pre-ACP answer bit-for-bit when there is no engine record, so a
   * capability fetch that never happened can never take an affordance away.
   */
  const engine = conversation.engineCapabilities;
  /**
   * The engine is a packetcode that sent the `_packetcode` vendor block, so
   * its flags are authoritative. When it advertised nothing, the flags are all
   * `false` and mean NOTHING — the backend's call-time method-not-found
   * fallbacks still decide — so they must never be read as "feature missing".
   */
  const engineAdvertised = engine?.packetcode.advertised === true;

  return {
    // Source: api-models.providerSupportsApprovals (catalog `supportsApprovals`,
    // defaulting to true) — exactly what AgentModeChip asked for itself.
    canApprovePerTool,
    // Source: agentModeChipUtils.modesForApprovals, INTERSECTED with what the
    // engine said it accepts. The mode chip only ever mounted for
    // `mode === "api"` conversations, so PTY still gets an empty set; every
    // non-ACP transport carries no engine record and so keeps the full
    // `modesForApprovals` answer untouched. The real engine advertises only
    // ["ask", "read-only"], which keeps `plan`/`manual`/`deny` and drops
    // `default`/`yolo` — the two whose ACP modes (`auto`, `bypass`) it would
    // refuse. How a chip PRESENTS a restricted set is a separate design
    // question; this field's only job is to be truthful about it.
    permissionModes: isApi
      ? restrictToEngineModes(modesForApprovals(canApprovePerTool), engine)
      : [],
    permissionVocabulary: canApprovePerTool ? "approval" : "sandbox",
    // Source: the engine's advertised `defaultPermissionMode`. `null` for
    // every non-ACP session, so no existing surface changes.
    providerDefaultModeLabel: engineDefaultModeLabel(engine),
    // The "Approve writes" row lives in the mode chip's popover, which mounts
    // on the same `mode === "api"` condition.
    canGateWrites: isApi,
    canPlanMode: isApi,

    // Source: the engine's own `_packetcode/models/list` enumeration when it
    // advertised `modelsList`, else api-models.API_PROVIDERS. ModelSelector
    // already rendered nothing when the agent had no catalog row, so an empty
    // list is today's "no picker" answer. The ACP catalog row is documented as
    // SEEDED, not authoritative — the engine's answer supersedes it.
    models: engineModels(conversation) ?? getProviderForAgent(agent)?.models ?? [],
    // No API-agent surface exposes a reasoning-effort control today (the
    // `--effort` flag is a PTY/CLI workspace concept). null = omit the control.
    effortLevels: null,
    // ThinkingBlock renders whenever a message carries `thinking` text, which
    // only API sessions ever produce. NOT gated on `conversation.thinkingEnabled`
    // — that flag is a launch-time request, not a report of what arrived.
    emitsThinking: isApi,
    structuredPlans: emitsStructuredPlans(agent),

    // Pending edits / ReviewBar / diff surfaces all mount on `mode === "api"`.
    structuredEdits: isApi,
    // The composer's Stop button renders for any active conversation today,
    // with no provider or mode test.
    canCancelTurn: true,
    // agentTaskStore.sendMessage queues into `queuedMessages` for every
    // conversation kind.
    canQueueWhileStreaming: true,

    // FileMentionPopover is gated on having a project path to scan — and, on
    // ACP, on the engine being able to answer `_packetcode/project/files`.
    fileMentions: !!conversation.projectPath && (engine ? engineAdvertised : true),
    // Builtin + project + template slash commands are offered to every chat
    // session — except an ACP session whose engine cannot serve
    // `_packetcode/commands/list`.
    //
    // Neither extension has a flag of its own in the vendor block, so
    // `advertised` is the gate: it is the only signal that separates a
    // packetcode engine (which serves the whole `_packetcode/*` family) from
    // an older one or a third-party ACP agent (where both calls answer
    // method-not-found and the backend degrades them to an EMPTY list). An
    // affordance that can only ever open an empty menu is exactly the silent
    // no-op the pane's governing rule says to hide.
    slashCommands: engine ? engineAdvertised : true,
    // Attachment staging (paste/drop) is variant-agnostic in the composer.
    imageAttachments: true,

    // Source: modelContext.getModelContextWindow, which always resolves a
    // directional number (unknown ids fall back to the field median), so this
    // is non-null today. Kept nullable so an adapter that genuinely cannot
    // report a window can omit the ring instead of inventing one.
    contextWindow: getModelContextWindow(conversation.model),
    // Api sessions report usage — unless the engine says it does not serve
    // `_packetcode/sessions/usage`, in which case the statusline's ctx/in/out
    // would sit empty forever.
    reportsUsage: isApi && (engine ? engine.packetcode.sessionsUsage : true),
    // Source: conversationCost.getModelRates → shared/model-pricing.json,
    // with the SAME zero-rate guard api-models.ts applies when populating the
    // picker's price labels: a free/local model has an entry at 0/0, and
    // "$0.00" is a fiction, not a price.
    reportsCost: hasMeaningfulRates(conversation.model),

    // Source: remoteConversation.isRemoteConversation.
    remote: isRemoteConversation(conversation),
    // Source: the `mcp_sources` event persisted on the conversation (same
    // condition SessionMetaLine used for its pill), OR — on ACP, where that
    // event never fires — the engine's own advertisement. `mcpList` is what
    // makes the configured-server disclosure readable at all; `mcpDefaults` is
    // the promise that a session could inherit those servers, which is itself
    // a thing worth disclosing. Additive, so no non-ACP conversation changes.
    mcp:
      (!!mcpSources &&
        (mcpSources.sources.length > 0 || mcpSources.readErrors.length > 0)) ||
      (!!engine && (engine.packetcode.mcpList || engine.packetcode.mcpDefaults)),
    // Every conversation record is renamable; the sidebar has simply never
    // offered the affordance. Busy-state gating stays the caller's job.
    //
    // ACP is the exception: an engine session's name lives in the ENGINE's
    // store, so a rename that cannot reach `_packetcode/sessions/rename` would
    // be reverted by the next listing. Gated on `sessionsRename` accordingly.
    canRename: engine ? engine.packetcode.sessionsRename : true,
    // MessageList offers edit/restore on every user turn regardless of mode.
    canFork: true,
    usesProviderCredential: isApiAgentId(agent),
  };
}
