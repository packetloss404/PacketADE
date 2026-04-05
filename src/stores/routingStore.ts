import { create } from "zustand";
import { loadFromStorage, saveToStorage } from "@/lib/storage";
import type { TaskType } from "@/types/flight";
import type { RouteMapping } from "@/types/routing";
import { ALL_TASK_TYPES } from "@/types/routing";

const STORAGE_KEY = "packetcode:routing";

const DEFAULT_AGENT = "claude-code";

function buildDefaults(): RouteMapping[] {
  return ALL_TASK_TYPES.map((taskType) => ({
    taskType,
    agentConfigId: DEFAULT_AGENT,
    model: null,
  }));
}

function loadMappings(): RouteMapping[] {
  const saved = loadFromStorage<RouteMapping[]>(STORAGE_KEY, []);
  if (saved.length === 0) return buildDefaults();

  // Ensure every task type has a mapping (in case new types were added)
  const defaults = buildDefaults();
  return defaults.map(
    (d) => saved.find((s) => s.taskType === d.taskType) ?? d,
  );
}

function saveMappings(mappings: RouteMapping[]) {
  saveToStorage(STORAGE_KEY, mappings);
}

interface RoutingStore {
  mappings: RouteMapping[];
  setMapping: (taskType: TaskType, agentConfigId: string, model: string | null) => void;
  resetToDefaults: () => void;
  resolveForTask: (taskType: TaskType) => { agentConfigId: string; model?: string };
}

export const useRoutingStore = create<RoutingStore>((set, get) => ({
  mappings: loadMappings(),

  setMapping: (taskType, agentConfigId, model) => {
    set((s) => {
      const mappings = s.mappings.map((m) =>
        m.taskType === taskType ? { ...m, agentConfigId, model } : m,
      );
      saveMappings(mappings);
      return { mappings };
    });
  },

  resetToDefaults: () => {
    const mappings = buildDefaults();
    saveMappings(mappings);
    set({ mappings });
  },

  resolveForTask: (taskType) => {
    const mapping = get().mappings.find((m) => m.taskType === taskType);
    if (!mapping) return { agentConfigId: DEFAULT_AGENT };
    return {
      agentConfigId: mapping.agentConfigId,
      ...(mapping.model ? { model: mapping.model } : {}),
    };
  },
}));
