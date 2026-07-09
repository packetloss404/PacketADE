/**
 * Tile program (P4-S1) — sessionStatus: the SINGLE status truth.
 *
 * A pure rollup selector layered on P1-S2's `sessionIndex`. A workspace's
 * status is the MAX severity across its member tiles; this is the one source
 * that drives the tab-strip dot (`WorkspaceView`), the sidebar rows (P4-S2's
 * FleetSidebar), and `RunningAgentsChip`. No other surface may compute status
 * independently.
 *
 * Rulings honored:
 * - Single truth: every status surface reads from here, never re-derives.
 * - Severity order (ruled, features.md): needs_you > failed > working > done
 *   > idle. `failed` outranks `working`/`done`/`idle` so a workspace with an
 *   errored tile always surfaces red beside a live/idle sibling — the honest-UI
 *   mandate: a rollup never hides a failure.
 * - PTY tiles ONLY ever contribute working/idle — no fake PTY done/failed
 *   states (a live PTY reads working, a dead one idle; a real pattern-parser
 *   signal can be threaded in via the optional `ptyAttention` map without
 *   changing this module).
 * - Pure: the rollup takes fully-materialized inputs and is trivially testable
 *   with zero stores; the `select*`/`use*` helpers are the live read surface.
 */
import { useMemo } from "react";
import type { Workspace, WorkspacePane } from "@/types/workspace";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import {
  flightAttemptSessionIds,
  projectConversationSessions,
  type Attention,
  type ConversationSession,
} from "@/lib/sessionIndex";

export type { Attention } from "@/lib/sessionIndex";

/**
 * Severity ranks — the ONE ordering (ruled, features.md): needs_you > failed >
 * working > done > idle. Higher wins the rollup. `failed` sits second so an
 * errored tile is never masked by a working/done/idle sibling (honest UI). Kept
 * private; consumers compare through {@link rollupAttention}, never by reaching
 * for the numbers.
 */
const SEVERITY: Record<Attention, number> = {
  needs_you: 5,
  failed: 4,
  working: 3,
  done: 2,
  idle: 1,
};

/**
 * The rollup core: the highest-severity attention among a workspace's member
 * tiles. Pure and total. An empty workspace (no tiles) collapses to `idle` —
 * there is nothing demanding attention.
 */
export function rollupAttention(members: readonly Attention[]): Attention {
  let best: Attention | null = null;
  for (const m of members) {
    if (best === null || SEVERITY[m] > SEVERITY[best]) best = m;
  }
  return best ?? "idle";
}

/**
 * The attention a single pane contributes to its workspace's rollup.
 *
 * - Conversation panes read the projected conversation attention (the five-word
 *   vocabulary from `sessionIndex`); a pane whose conversation is absent from
 *   the projection (deleted / not yet loaded) reads `idle`.
 * - Terminal/PTY panes read `working`/`idle` ONLY. A caller with a real
 *   post-debounce pattern-parser signal passes `ptyAttention` (paneId →
 *   working|idle); otherwise liveness stands in (a bound PTY session ⇒ working,
 *   else idle). PTYs never contribute done/failed.
 */
export function paneAttention(
  pane: WorkspacePane,
  conversationAttention: ReadonlyMap<string, Attention>,
  ptyAttention?: ReadonlyMap<string, "working" | "idle">,
): Attention {
  if (pane.kind === "conversation" && pane.conversationId) {
    return conversationAttention.get(pane.conversationId) ?? "idle";
  }
  const signal = ptyAttention?.get(pane.id);
  if (signal) return signal;
  return pane.sessionId ? "working" : "idle";
}

/**
 * A workspace's rolled-up status: {@link rollupAttention} over every member
 * pane's {@link paneAttention}. Pure — the caller supplies the conversation
 * attention map (from `sessionIndex`) and, optionally, live PTY signals.
 */
export function computeWorkspaceStatus(
  workspace: Workspace,
  conversationAttention: ReadonlyMap<string, Attention>,
  ptyAttention?: ReadonlyMap<string, "working" | "idle">,
): Attention {
  const members = workspace.panes.map((p) =>
    paneAttention(p, conversationAttention, ptyAttention),
  );
  return rollupAttention(members);
}

/** Build a `conversationId → attention` lookup from projected sessions. */
function conversationAttentionMap(
  sessions: readonly ConversationSession[],
): Map<string, Attention> {
  const map = new Map<string, Attention>();
  for (const s of sessions) map.set(s.conversationId, s.attention);
  return map;
}

// ─── Live read surface (getState — for imperative reads and tests) ──────────

/**
 * Live `conversationId → attention` projection, reading current store
 * snapshots. The SINGLE source consumers filter for "running"/"needs-you"
 * counts — never a bespoke `status === "active"` scan.
 */
export function selectConversationAttention(): Map<string, Attention> {
  const conversations = useAgentTaskStore.getState().conversations;
  const workspaces = useWorkspaceStore.getState().workspaces;
  const flights = useFlightStore.getState().flights;
  const approvals = useAgentApprovalStore.getState();
  const plans = useAgentPlanStore.getState();
  const sessions = projectConversationSessions({
    conversations,
    workspaces,
    attemptSessionIds: flightAttemptSessionIds(flights),
    approvals: { permissions: approvals.permissions, edits: approvals.edits },
    plans: { plan: plans.plan, planApproved: plans.planApproved },
  });
  return conversationAttentionMap(sessions);
}

/**
 * Live `workspaceId → rolled-up status` map — the tab-strip dot and sidebar
 * rows read this. PTY panes fall back to liveness (no runtime signal wired at
 * this layer).
 */
export function selectWorkspaceStatuses(): Map<string, Attention> {
  const conversationAttention = selectConversationAttention();
  const workspaces = useWorkspaceStore.getState().workspaces;
  const out = new Map<string, Attention>();
  for (const w of workspaces) {
    out.set(w.id, computeWorkspaceStatus(w, conversationAttention));
  }
  return out;
}

/** Live rolled-up status for one workspace (or `idle` if it does not exist). */
export function selectWorkspaceStatus(workspaceId: string): Attention {
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return "idle";
  return computeWorkspaceStatus(workspace, selectConversationAttention());
}

// ─── React hooks (reactive — the component read surface) ────────────────────

/**
 * Reactive `conversationId → attention` map. Subscribes to exactly the slices
 * that feed the projection so a consumer re-renders when — and only when — a
 * conversation's attention could change.
 */
export function useConversationAttention(): Map<string, Attention> {
  const conversations = useAgentTaskStore((s) => s.conversations);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const flights = useFlightStore((s) => s.flights);
  const permissions = useAgentApprovalStore((s) => s.permissions);
  const edits = useAgentApprovalStore((s) => s.edits);
  const plan = useAgentPlanStore((s) => s.plan);
  const planApproved = useAgentPlanStore((s) => s.planApproved);
  return useMemo(() => {
    const sessions = projectConversationSessions({
      conversations,
      workspaces,
      attemptSessionIds: flightAttemptSessionIds(flights),
      approvals: { permissions, edits },
      plans: { plan, planApproved },
    });
    return conversationAttentionMap(sessions);
  }, [conversations, workspaces, flights, permissions, edits, plan, planApproved]);
}

/**
 * Reactive `workspaceId → rolled-up status` map — the tab-strip dot consumer.
 * Shares subscriptions with {@link useConversationAttention} and rolls each
 * workspace up over its panes.
 */
export function useWorkspaceStatuses(): Map<string, Attention> {
  const conversationAttention = useConversationAttention();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return useMemo(() => {
    const out = new Map<string, Attention>();
    for (const w of workspaces) {
      out.set(w.id, computeWorkspaceStatus(w, conversationAttention));
    }
    return out;
  }, [workspaces, conversationAttention]);
}

// ─── Visual mapping (shared so every surface renders the same dot) ──────────

export interface AttentionDot {
  /** Tailwind background token for the status dot. */
  className: string;
  /** Whether the dot pulses (live attention: needs_you / working). */
  pulse: boolean;
}

/**
 * The ONE attention → dot mapping, shared by the tab strip and (P4-S2) the
 * sidebar rows so status reads identically everywhere:
 *   needs_you → amber pulse · working → green pulse · idle → faint ·
 *   done → blue · failed → red.
 */
export function attentionDot(attention: Attention): AttentionDot {
  switch (attention) {
    case "needs_you":
      return { className: "bg-accent-amber", pulse: true };
    case "working":
      return { className: "bg-accent-green", pulse: true };
    case "done":
      return { className: "bg-accent-blue", pulse: false };
    case "failed":
      return { className: "bg-accent-red", pulse: false };
    case "idle":
    default:
      return { className: "bg-text-faint", pulse: false };
  }
}
