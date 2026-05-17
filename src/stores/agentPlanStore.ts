import { create } from "zustand";
import type { AgentPlanItem } from "@/types/agent-conversation";

/**
 * Lazy accessor for agentTaskStore to avoid a circular import at module
 * load time (agentTaskStore imports this file). By the time any action
 * here runs, both modules are fully initialized.
 */
async function importTaskStore(): Promise<typeof import("@/stores/agentTaskStore")> {
  return await import("@/stores/agentTaskStore");
}

/**
 * Plan / spec FSM substore split out of agentTaskStore. Owns the
 * `spec` → `plan` → `code` stage transitions, the user-edited success
 * criteria, the latest TodoWrite snapshot, and the planApproved flag.
 *
 * Not persisted directly here — agentTaskStore mirrors these values onto
 * the saved `AgentConversation` (spec / specStage / plan / planApproved
 * fields) and hydrates them back into this store on startup. Keeping the
 * disk format unchanged means existing persisted conversations parse
 * without migration.
 */

export type SpecStage = "spec" | "plan" | "code";
export interface SpecRecord {
  criteria: string[];
  status: "draft" | "approved";
  updatedAt: number;
}

interface AgentPlanState {
  /** F10: success-criteria collected while specStage === "spec". */
  spec: Map<string, SpecRecord>;
  /** F10: which stage of the Spec → Plan → Code FSM the conversation
   * is in. Undefined entries map to the legacy pre-FSM flow where the
   * mode chip drives everything. */
  specStage: Map<string, SpecStage>;
  /** v3: latest TodoWrite snapshot from the `api-agent:plan-block:*`
   * event. PlanPanel falls back to parsing tool calls if absent. */
  plan: Map<string, AgentPlanItem[]>;
  /** F10: true once the user has approved the model's plan. */
  planApproved: Map<string, boolean>;

  setSpec: (conversationId: string, criteria: string[]) => void;
  setSpecStage: (conversationId: string, stage: SpecStage) => void;
  /** F10: lock the spec, advance the stage to "plan", and post a
   * synthesized user turn asking the agent for a TodoWrite plan. */
  approveSpec: (conversationId: string) => void;
  setPlan: (conversationId: string, items: AgentPlanItem[]) => void;
  /** F10: approve the model's plan. Flips planApproved + advances stage
   * to "code", lifts plan mode (if it was on), and posts the execute
   * turn. Idempotent: no-op when already approved. */
  approvePlan: (conversationId: string) => void;

  /** Selector helpers for grouped reads. */
  getSpec: (conversationId: string) => SpecRecord | undefined;
  getSpecStage: (conversationId: string) => SpecStage | undefined;
  getPlan: (conversationId: string) => AgentPlanItem[] | undefined;
  getPlanApproved: (conversationId: string) => boolean;

  /** Hydrate from a persisted conversation. Called on app startup for
   * every API conversation that comes back from disk so the new store's
   * Maps match what `AgentConversation.spec` / etc. had. */
  hydrateConversation: (
    conversationId: string,
    payload: {
      spec?: SpecRecord;
      specStage?: SpecStage;
      plan?: AgentPlanItem[];
      planApproved?: boolean;
    },
  ) => void;

  clearConversation: (conversationId: string) => void;
}

export const useAgentPlanStore = create<AgentPlanState>((set, get) => ({
  spec: new Map(),
  specStage: new Map(),
  plan: new Map(),
  planApproved: new Map(),

  setSpec: (conversationId, criteria) => {
    set((s) => {
      const nextSpec = new Map(s.spec);
      nextSpec.set(conversationId, {
        criteria,
        status: "draft",
        updatedAt: Date.now(),
      });
      // Seed the stage if it wasn't already set — first-time spec editing
      // should land in the spec stage even if the conversation was created
      // pre-FSM.
      const nextStage = new Map(s.specStage);
      if (!nextStage.has(conversationId)) nextStage.set(conversationId, "spec");
      return { spec: nextSpec, specStage: nextStage };
    });
    void importTaskStore().then(({ requestConversationSave }) =>
      requestConversationSave(conversationId),
    );
  },

  setSpecStage: (conversationId, stage) => {
    set((s) => {
      const next = new Map(s.specStage);
      next.set(conversationId, stage);
      return { specStage: next };
    });
    void importTaskStore().then(({ requestConversationSave }) =>
      requestConversationSave(conversationId),
    );
  },

  approveSpec: (conversationId) => {
    const current = get().spec.get(conversationId);
    if (!current || current.criteria.length === 0) return;
    const approved: SpecRecord = {
      ...current,
      status: "approved",
      updatedAt: Date.now(),
    };
    set((s) => {
      const nextSpec = new Map(s.spec);
      nextSpec.set(conversationId, approved);
      const nextStage = new Map(s.specStage);
      nextStage.set(conversationId, "plan");
      return { spec: nextSpec, specStage: nextStage };
    });
    // Synthesize a user turn requesting the structured plan.
    const bullets = approved.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const prompt =
      `Spec approved. Success criteria:\n${bullets}\n\n` +
      `Now produce a Plan via TodoWrite covering each criterion. ` +
      `Stop after the plan — wait for user approval before executing.`;
    void importTaskStore().then(({ requestConversationSave, useAgentTaskStore }) => {
      requestConversationSave(conversationId);
      useAgentTaskStore.getState().sendMessage(conversationId, prompt);
    });
  },

  setPlan: (conversationId, items) => {
    set((s) => {
      const next = new Map(s.plan);
      next.set(conversationId, items);
      return { plan: next };
    });
  },

  approvePlan: (conversationId) => {
    if (get().planApproved.get(conversationId)) return;
    set((s) => {
      const nextApproved = new Map(s.planApproved);
      nextApproved.set(conversationId, true);
      const nextStage = new Map(s.specStage);
      nextStage.set(conversationId, "code");
      return { planApproved: nextApproved, specStage: nextStage };
    });
    void importTaskStore().then(({ requestConversationSave, useAgentTaskStore }) => {
      requestConversationSave(conversationId);
      const store = useAgentTaskStore.getState();
      const conv = store.conversations.find((c) => c.id === conversationId);
      // Lift plan mode if it was on (the launcher's Plan mode set it on
      // start) and tell the model to execute.
      if (conv?.planMode) {
        void store.setPlanMode(conversationId, false);
      }
      store.sendMessage(
        conversationId,
        "Plan approved. Execute step-by-step, marking TodoWrite items as you complete them.",
      );
    });
  },

  getSpec: (conversationId) => get().spec.get(conversationId),
  getSpecStage: (conversationId) => get().specStage.get(conversationId),
  getPlan: (conversationId) => get().plan.get(conversationId),
  getPlanApproved: (conversationId) => get().planApproved.get(conversationId) ?? false,

  hydrateConversation: (conversationId, payload) => {
    set((s) => {
      const nextSpec = new Map(s.spec);
      const nextStage = new Map(s.specStage);
      const nextPlan = new Map(s.plan);
      const nextApproved = new Map(s.planApproved);
      if (payload.spec) nextSpec.set(conversationId, payload.spec);
      if (payload.specStage) nextStage.set(conversationId, payload.specStage);
      if (payload.plan && payload.plan.length > 0)
        nextPlan.set(conversationId, payload.plan);
      if (payload.planApproved) nextApproved.set(conversationId, true);
      return {
        spec: nextSpec,
        specStage: nextStage,
        plan: nextPlan,
        planApproved: nextApproved,
      };
    });
  },

  clearConversation: (conversationId) => {
    set((s) => {
      const nextSpec = new Map(s.spec);
      const nextStage = new Map(s.specStage);
      const nextPlan = new Map(s.plan);
      const nextApproved = new Map(s.planApproved);
      let touched = false;
      if (nextSpec.delete(conversationId)) touched = true;
      if (nextStage.delete(conversationId)) touched = true;
      if (nextPlan.delete(conversationId)) touched = true;
      if (nextApproved.delete(conversationId)) touched = true;
      if (!touched) return s;
      return {
        spec: nextSpec,
        specStage: nextStage,
        plan: nextPlan,
        planApproved: nextApproved,
      };
    });
  },
}));
