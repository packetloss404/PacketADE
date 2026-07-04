import { create } from "zustand";
import type { AgentPlanItem, PermissionMode } from "@/types/agent-conversation";

/**
 * Lazy accessor for agentTaskStore to avoid a circular import at module
 * load time (agentTaskStore imports this file). By the time any action
 * here runs, both modules are fully initialized.
 */
async function importTaskStore(): Promise<typeof import("@/stores/agentTaskStore")> {
  return await import("@/stores/agentTaskStore");
}

/**
 * Plan substore split out of agentTaskStore. Owns the latest TodoWrite
 * snapshot and the planApproved flag. Plan approval is unified here:
 * every approval surface (the inline PlanModeApprovalMenu is THE path)
 * calls `approvePlan`, so PlanPanel's proposed/approved state can never
 * desync from the approval action and repeat clicks can never double-send
 * the execute turn.
 *
 * Not persisted directly here — agentTaskStore mirrors these values onto
 * the saved `AgentConversation` (plan / planApproved fields) and hydrates
 * them back into this store on startup. Keeping the disk format unchanged
 * means existing persisted conversations parse without migration.
 */

/** Permission posture an approval surface wants applied alongside approval.
 * Applied by `approvePlan` AFTER it lifts plan mode: on sidecar sessions plan
 * mode and permission mode share ONE wire dimension (set_plan_mode(false)
 * forwards permission mode "default"), so a posture set before the lift
 * would be silently clobbered back to "default". */
export interface PlanApprovalPosture {
  permissionMode?: PermissionMode;
  approveWrites?: boolean;
}

interface AgentPlanState {
  /** v3: latest TodoWrite snapshot from the `api-agent:plan-block:*`
   * event. PlanPanel falls back to parsing tool calls if absent. */
  plan: Map<string, AgentPlanItem[]>;
  /** True once the user has approved the model's plan. */
  planApproved: Map<string, boolean>;

  setPlan: (conversationId: string, items: AgentPlanItem[]) => void;
  /** Unified plan approval. Flips planApproved, lifts plan mode (if it
   * was on), applies the requested permission `posture`, and posts the
   * execute turn (`message` overrides the default execute prompt so
   * approval surfaces can vary the posture wording). Strictly ordered:
   * lift plan mode → apply posture → dispatch, so the sidecar's shared
   * plan/permission wire dimension can't clobber the posture.
   * Idempotent: no-op when already approved — this is what kills the
   * repeat-click double-send. */
  approvePlan: (
    conversationId: string,
    message?: string,
    posture?: PlanApprovalPosture,
  ) => void;
  /** Re-arm approval for a new planning round. Called when plan mode is
   * switched back ON so a previously-approved conversation can approve
   * (and dispatch) a fresh plan instead of no-oping forever. */
  resetPlanApproval: (conversationId: string) => void;

  /** Selector helpers for grouped reads. */
  getPlan: (conversationId: string) => AgentPlanItem[] | undefined;
  getPlanApproved: (conversationId: string) => boolean;

  /** Hydrate from a persisted conversation. Called on app startup for
   * every API conversation that comes back from disk so the new store's
   * Maps match what `AgentConversation.plan` / `planApproved` had. */
  hydrateConversation: (
    conversationId: string,
    payload: {
      plan?: AgentPlanItem[];
      planApproved?: boolean;
    },
  ) => void;

  clearConversation: (conversationId: string) => void;
}

const DEFAULT_EXECUTE_MESSAGE =
  "Plan approved. Execute step-by-step, marking TodoWrite items as you complete them.";

export const useAgentPlanStore = create<AgentPlanState>((set, get) => ({
  plan: new Map(),
  planApproved: new Map(),

  setPlan: (conversationId, items) => {
    set((s) => {
      const next = new Map(s.plan);
      next.set(conversationId, items);
      return { plan: next };
    });
    // Persist like every sibling mutator — snapshotForPersist reads the plan
    // back out of this store, so any caller must trigger a save.
    void importTaskStore().then(({ requestConversationSave }) =>
      requestConversationSave(conversationId),
    );
  },

  approvePlan: (conversationId, message, posture) => {
    if (get().planApproved.get(conversationId)) return;
    set((s) => {
      const nextApproved = new Map(s.planApproved);
      nextApproved.set(conversationId, true);
      return { planApproved: nextApproved };
    });
    void importTaskStore().then(async ({ requestConversationSave, useAgentTaskStore }) => {
      requestConversationSave(conversationId);
      const store = useAgentTaskStore.getState();
      const conv = store.conversations.find((c) => c.id === conversationId);
      // Lift plan mode if it was on (the launcher's Plan mode set it on
      // start) BEFORE dispatching the execute turn, otherwise the execute
      // message can reach the backend while plan mode is still active.
      if (conv?.planMode) {
        await store.setPlanMode(conversationId, false);
      }
      // Apply the approval posture only AFTER the lift: sidecar sessions
      // map set_plan_mode(false) onto permission mode "default", so a
      // posture applied earlier would be reset on the backend while the
      // frontend store kept the requested mode — a permission desync.
      if (posture?.permissionMode !== undefined) {
        await store.setPermissionMode(conversationId, posture.permissionMode);
      }
      if (posture?.approveWrites !== undefined) {
        await store.setApproveWrites(conversationId, posture.approveWrites);
      }
      store.sendMessage(conversationId, message ?? DEFAULT_EXECUTE_MESSAGE);
    });
  },

  resetPlanApproval: (conversationId) => {
    set((s) => {
      if (!s.planApproved.has(conversationId)) return s;
      const nextApproved = new Map(s.planApproved);
      nextApproved.delete(conversationId);
      return { planApproved: nextApproved };
    });
  },

  getPlan: (conversationId) => get().plan.get(conversationId),
  getPlanApproved: (conversationId) => get().planApproved.get(conversationId) ?? false,

  hydrateConversation: (conversationId, payload) => {
    set((s) => {
      const nextPlan = new Map(s.plan);
      const nextApproved = new Map(s.planApproved);
      if (payload.plan && payload.plan.length > 0)
        nextPlan.set(conversationId, payload.plan);
      if (payload.planApproved) nextApproved.set(conversationId, true);
      return {
        plan: nextPlan,
        planApproved: nextApproved,
      };
    });
  },

  clearConversation: (conversationId) => {
    set((s) => {
      const nextPlan = new Map(s.plan);
      const nextApproved = new Map(s.planApproved);
      let touched = false;
      if (nextPlan.delete(conversationId)) touched = true;
      if (nextApproved.delete(conversationId)) touched = true;
      if (!touched) return s;
      return {
        plan: nextPlan,
        planApproved: nextApproved,
      };
    });
  },
}));
