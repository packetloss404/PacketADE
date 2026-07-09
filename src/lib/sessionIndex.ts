/**
 * Tile program (P1-S2) — sessionIndex: the derived-projection session model.
 *
 * PURE SELECTORS, ZERO STATE. `sessionIndex` projects the two independent
 * engines (agentTaskStore = headless conversations, workspaceStore = placement)
 * into a single `UnifiedSession` row shape with ONE attention vocabulary. It is
 * a deletable read-only projection: removing it can never touch either engine.
 * Nothing here mutates a store; the live `select*` helpers only read `getState`.
 *
 * Rulings honored:
 * - Derived projection, never a merged store.
 * - Five-word attention vocabulary EXACTLY: needs_you | working | idle | done |
 *   failed.
 * - Enumerates ALL conversations — placed, unplaced, AND archived.
 * - Excludes Flight Deck attempt conversations via a memoized read-layer lookup
 *   set of flight attempt sessionIds (no engine flag).
 * - Reference direction is pane→conversationId ONLY; `sessionId` stays PTY-only
 *   (surfaced as `ptySessionId` on the pty variant).
 */
import type {
  AgentConversation,
  AgentPlanItem,
  PendingEdit,
  PendingPermission,
} from "@/types/agent-conversation";
import type { Workspace } from "@/types/workspace";
import type { Flight } from "@/types/flight";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";

/** The ONLY status vocabulary — five words, exactly (ruled). */
export type Attention = "needs_you" | "working" | "idle" | "done" | "failed";

interface UnifiedSessionBase {
  /** Row identity. For conversations this equals `conversationId`. */
  id: string;
  /** Placement: the workspace holding a tile for this session, if any. */
  workspaceId?: string;
  /** Placement: the specific pane, if placed. */
  paneId?: string;
  title: string;
  projectPath: string;
  attention: Attention;
  updatedAt: number;
  archived: boolean;
}

export interface ConversationSession extends UnifiedSessionBase {
  kind: "conversation";
  conversationId: string;
  provider?: string;
  model?: string;
}

export interface PtySession extends UnifiedSessionBase {
  kind: "pty";
  /** PTY-only — never carried on the conversation side (sessionId stays
   *  PTY-only per the ruling). */
  ptySessionId: string;
}

export type UnifiedSession = ConversationSession | PtySession;

/**
 * Raw signals feeding {@link attentionFor}. The conversation side reads the
 * approval + plan + streaming/status engines; the PTY side takes an
 * already-resolved signal from the adapter pattern-parser (the ~750ms debounce
 * is a stateful runtime concern that lives in the consumer, not this pure
 * module — see Phase 4). PTYs never report done/failed.
 */
export type AttentionInput =
  | {
      kind: "conversation";
      status: AgentConversation["status"];
      /** A pending permission prompt or write-edit is queued (agentApprovalStore). */
      hasPendingApproval: boolean;
      /** A model plan awaits the user's approval (agentPlanStore). */
      hasPendingPlan: boolean;
      /** A turn is actively streaming. */
      isStreaming: boolean;
    }
  | {
      kind: "pty";
      /** Post-debounce signal from the adapter pattern-parser. `needs_you`
       *  arises ONLY from `approval_needed`. */
      signal: "approval_needed" | "working" | "idle";
    };

/**
 * The sole attention mapping. Deterministic, pure, total.
 *
 * Conversation precedence: a pending approval / plan wins (needs_you), then
 * terminal failure, then terminal done, then an active/streaming turn
 * (working), else idle. PTYs collapse to needs_you/working/idle only.
 */
export function attentionFor(input: AttentionInput): Attention {
  if (input.kind === "pty") {
    if (input.signal === "approval_needed") return "needs_you";
    if (input.signal === "working") return "working";
    return "idle";
  }
  if (input.hasPendingApproval || input.hasPendingPlan) return "needs_you";
  if (input.status === "failed") return "failed";
  if (input.status === "done") return "done";
  if (input.isStreaming || input.status === "active") return "working";
  return "idle";
}

// ─── Flight-attempt exclusion (memoized read-layer lookup) ──────────────────

let cachedFlights: readonly Flight[] | null = null;
let cachedAttemptIds: ReadonlySet<string> = new Set();

/**
 * Build (memoized on the `flights` array reference) the set of session ids that
 * belong to Flight Deck attempts. Attempt conversations share their id with the
 * backend attempt session (`explicitId`), so this set is exactly the ids to
 * exclude from the fleet projection — Flight Deck's attach-by-explicitId flow
 * stays untouched proof the engine runs headless.
 */
export function flightAttemptSessionIds(flights: readonly Flight[]): ReadonlySet<string> {
  if (flights === cachedFlights) return cachedAttemptIds;
  const set = new Set<string>();
  for (const flight of flights) {
    for (const attempt of flight.attempts ?? []) {
      if (attempt.sessionId) set.add(attempt.sessionId);
    }
  }
  cachedFlights = flights;
  cachedAttemptIds = set;
  return set;
}

// ─── Conversation projection ────────────────────────────────────────────────

/** Placement lookup: conversationId → the (workspace, pane) holding its tile. */
function buildPlacementIndex(
  workspaces: readonly Workspace[],
): Map<string, { workspaceId: string; paneId: string }> {
  const index = new Map<string, { workspaceId: string; paneId: string }>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      if (pane.kind === "conversation" && pane.conversationId) {
        // First placement wins — a conversation should have at most one tile,
        // but if a stray duplicate exists we deterministically keep the first.
        if (!index.has(pane.conversationId)) {
          index.set(pane.conversationId, { workspaceId: workspace.id, paneId: pane.id });
        }
      }
    }
  }
  return index;
}

export interface ProjectSessionsInput {
  conversations: readonly AgentConversation[];
  workspaces: readonly Workspace[];
  /** Session ids belonging to flight attempts — excluded from the projection. */
  attemptSessionIds: ReadonlySet<string>;
  approvals: {
    permissions: ReadonlyMap<string, PendingPermission[]>;
    edits: ReadonlyMap<string, PendingEdit[]>;
  };
  plans: {
    plan: ReadonlyMap<string, AgentPlanItem[]>;
    planApproved: ReadonlyMap<string, boolean>;
  };
}

/**
 * Project every conversation into a `ConversationSession` row. Includes placed,
 * unplaced, AND archived conversations; excludes flight attempts. Pure — takes
 * fully-materialized inputs so it is trivially testable without any store.
 */
export function projectConversationSessions(
  input: ProjectSessionsInput,
): ConversationSession[] {
  const placement = buildPlacementIndex(input.workspaces);
  const rows: ConversationSession[] = [];
  for (const conv of input.conversations) {
    // Read-layer exclusion of Flight Deck attempts — no engine flag.
    if (input.attemptSessionIds.has(conv.id)) continue;

    const place = placement.get(conv.id);
    const hasPendingApproval =
      (input.approvals.permissions.get(conv.id)?.length ?? 0) > 0 ||
      (input.approvals.edits.get(conv.id)?.length ?? 0) > 0;
    const isStreaming = conv.messages.some((m) => m.isStreaming);
    // A plan awaits approval when the conversation is in plan mode, the model
    // has produced a plan, it isn't approved yet, and no turn is streaming
    // (the model finished presenting it and is waiting on the user).
    const hasPendingPlan =
      Boolean(conv.planMode) &&
      (input.plans.plan.get(conv.id)?.length ?? 0) > 0 &&
      !input.plans.planApproved.get(conv.id) &&
      !isStreaming;

    rows.push({
      kind: "conversation",
      id: conv.id,
      conversationId: conv.id,
      workspaceId: place?.workspaceId,
      paneId: place?.paneId,
      title: conv.title,
      projectPath: conv.projectPath,
      provider: conv.provider,
      model: conv.model,
      attention: attentionFor({
        kind: "conversation",
        status: conv.status,
        hasPendingApproval,
        hasPendingPlan,
        isStreaming,
      }),
      updatedAt: conv.updatedAt,
      archived: conv.archived ?? false,
    });
  }
  return rows;
}

/**
 * Live conversation projection — reads current store snapshots and delegates to
 * the pure {@link projectConversationSessions}. Full sidebar consumption (PTY
 * rows, sorting, needs-you grouping) lands in Phase 4; this is the read surface
 * the fleet layer builds on.
 */
export function selectConversationSessions(): ConversationSession[] {
  const conversations = useAgentTaskStore.getState().conversations;
  const workspaces = useWorkspaceStore.getState().workspaces;
  const flights = useFlightStore.getState().flights;
  const approvals = useAgentApprovalStore.getState();
  const plans = useAgentPlanStore.getState();
  return projectConversationSessions({
    conversations,
    workspaces,
    attemptSessionIds: flightAttemptSessionIds(flights),
    approvals: { permissions: approvals.permissions, edits: approvals.edits },
    plans: { plan: plans.plan, planApproved: plans.planApproved },
  });
}
