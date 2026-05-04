import { create } from "zustand";
import { generateId, loadFromStorage, saveToStorage } from "@/lib/storage";
import { storageKey } from "@/lib/brand";
import type { AgentPlanItem } from "@/types/agent-conversation";
import type { Goal, GoalStatus } from "@/types/goal";

const STORAGE_KEY = storageKey("goals");
const SCHEMA_VERSION = 1;

interface PersistShape {
  version: number;
  goals: Goal[];
}

function loadPersisted(): Goal[] {
  const raw = loadFromStorage<PersistShape | Goal[]>(STORAGE_KEY, {
    version: SCHEMA_VERSION,
    goals: [],
  });
  if (Array.isArray(raw)) return raw; // legacy bare-array fallback
  if (raw && typeof raw === "object" && Array.isArray(raw.goals)) {
    return raw.goals;
  }
  return [];
}

function persist(goals: Goal[]): void {
  saveToStorage(STORAGE_KEY, {
    version: SCHEMA_VERSION,
    goals,
  } satisfies PersistShape);
}

interface GoalStore {
  goals: Goal[];

  addGoal: (
    input: Pick<Goal, "title"> &
      Partial<
        Pick<Goal, "missionId" | "conversationId" | "checklist" | "status">
      >,
  ) => string;
  updateGoal: (id: string, updates: Partial<Goal>) => void;
  deleteGoal: (id: string) => void;

  bindToConversation: (goalId: string, conversationId: string) => void;
  bindToMission: (goalId: string, missionId: string) => void;
  unbindFromMission: (goalId: string) => void;

  pauseGoal: (id: string) => void;
  resumeGoal: (id: string) => void;
  completeGoal: (id: string) => void;
  cancelGoal: (id: string) => void;

  /** Sync the bound conversation's checklist into the goal snapshot.
   * Called by PlanPanel whenever `conversation.plan` changes so the
   * snapshot stays current for cross-conversation continuation. */
  syncChecklistFromConversation: (
    goalId: string,
    items: AgentPlanItem[],
  ) => void;

  getGoalsForMission: (missionId: string) => Goal[];
  getGoalForConversation: (conversationId: string) => Goal | undefined;
}

export const useGoalStore = create<GoalStore>((set, get) => ({
  goals: loadPersisted(),

  addGoal: (input) => {
    const now = Date.now();
    const goal: Goal = {
      id: generateId("goal"),
      title: input.title,
      status: input.status ?? "active",
      missionId: input.missionId,
      conversationId: input.conversationId,
      checklist: input.checklist,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().goals, goal];
    set({ goals: next });
    persist(next);
    return goal.id;
  },

  updateGoal: (id, updates) => {
    const next = get().goals.map((g) =>
      g.id === id ? { ...g, ...updates, updatedAt: Date.now() } : g,
    );
    set({ goals: next });
    persist(next);
  },

  deleteGoal: (id) => {
    const next = get().goals.filter((g) => g.id !== id);
    set({ goals: next });
    persist(next);
  },

  bindToConversation: (goalId, conversationId) => {
    get().updateGoal(goalId, { conversationId });
  },
  bindToMission: (goalId, missionId) => {
    get().updateGoal(goalId, { missionId });
  },
  unbindFromMission: (goalId) => {
    get().updateGoal(goalId, { missionId: undefined });
  },

  pauseGoal: (id) => {
    get().updateGoal(id, { status: "paused" as GoalStatus });
  },
  resumeGoal: (id) => {
    get().updateGoal(id, { status: "active" as GoalStatus });
  },
  completeGoal: (id) => {
    get().updateGoal(id, { status: "completed" as GoalStatus });
  },
  cancelGoal: (id) => {
    get().updateGoal(id, { status: "cancelled" as GoalStatus });
  },

  syncChecklistFromConversation: (goalId, items) => {
    const goal = get().goals.find((g) => g.id === goalId);
    if (!goal) return;
    // Cheap shallow check — items are stable references between renders
    // when conversation.plan hasn't changed, so most calls are no-ops.
    if (goal.checklist === items) return;
    get().updateGoal(goalId, { checklist: items });
  },

  getGoalsForMission: (missionId) =>
    get().goals.filter((g) => g.missionId === missionId),

  getGoalForConversation: (conversationId) =>
    get().goals.find((g) => g.conversationId === conversationId),
}));
