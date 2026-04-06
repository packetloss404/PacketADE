import { create } from "zustand";
import { loadFromStorage, removeFromStorage } from "@/lib/storage";
import { loadPersistedState, saveAgentsSlice } from "@/lib/tauri";
import type { AgentConfig } from "@/types/agent";
import { CLAUDE_CODE_CONFIG } from "@/agents/claude-code";
import { OPENCODE_CONFIG } from "@/agents/opencode";
import { CODEX_CONFIG } from "@/agents/codex";

const STORAGE_KEY = "packetcode:agents";

// Built-in agent configs (always present, user can override args/model)
const BUILTIN_AGENTS: AgentConfig[] = [CLAUDE_CODE_CONFIG, OPENCODE_CONFIG, CODEX_CONFIG];

interface AgentStoreState {
  agents: AgentConfig[];
  detecting: boolean;
}

interface AgentStore extends AgentStoreState {
  // CRUD
  addAgent: (agent: AgentConfig) => void;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void;
  removeAgent: (id: string) => void;
  getAgent: (id: string) => AgentConfig | undefined;

  // Install detection
  detectInstalled: () => Promise<void>;
  setInstalled: (id: string, installed: boolean) => void;

  // Reset built-ins
  resetBuiltins: () => void;
  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
}

const OVERRIDES_KEY = "packetcode:agent-overrides";

function loadState(): AgentStoreState {
  // Backend is the sole source of truth; real data arrives via hydrateFromBackend.
  return {
    agents: [...BUILTIN_AGENTS],
    detecting: false,
  };
}

function saveState(agents: AgentConfig[]) {
  void syncAgentsToBackend(agents);
}

async function syncAgentsToBackend(agents: AgentConfig[]) {
  try {
    await saveAgentsSlice(agents);
  } catch {
    // Keep localStorage as fallback when the Tauri bridge is unavailable.
  }
}

const initial = loadState();

export const useAgentStore = create<AgentStore>((set, get) => ({
  ...initial,

  addAgent: (agent) => {
    set((s) => {
      // Prevent duplicate IDs
      if (s.agents.some((a) => a.id === agent.id)) return s;
      const agents = [...s.agents, agent];
      saveState(agents);
      return { agents };
    });
  },

  updateAgent: (id, updates) => {
    set((s) => {
      const agents = s.agents.map((a) =>
        a.id === id ? { ...a, ...updates, id: a.id, isBuiltin: a.isBuiltin } : a,
      );
      saveState(agents);
      return { agents };
    });
  },

  removeAgent: (id) => {
    set((s) => {
      // Cannot remove built-in agents
      const agent = s.agents.find((a) => a.id === id);
      if (agent?.isBuiltin) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      saveState(agents);
      return { agents };
    });
  },

  getAgent: (id) => {
    return get().agents.find((a) => a.id === id);
  },

  detectInstalled: async () => {
    set({ detecting: true });
    try {
      const { detectAgent } = await import("@/lib/tauri");
      const agents = get().agents;
      const updates: { id: string; installed: boolean }[] = [];

      // Check all agents in parallel
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const installed = await detectAgent(agent.command);
            updates.push({ id: agent.id, installed });
          } catch {
            updates.push({ id: agent.id, installed: false });
          }
        }),
      );

      set((s) => {
        const updatedAgents = s.agents.map((a) => {
          const update = updates.find((u) => u.id === a.id);
          return update ? { ...a, installed: update.installed } : a;
        });
        saveState(updatedAgents);
        return { agents: updatedAgents, detecting: false };
      });
    } catch {
      set({ detecting: false });
    }
  },

  setInstalled: (id, installed) => {
    set((s) => {
      const agents = s.agents.map((a) => (a.id === id ? { ...a, installed } : a));
      return { agents };
    });
  },

  resetBuiltins: () => {
    set((s) => {
      const customAgents = s.agents.filter((a) => !a.isBuiltin);
      const agents = [...BUILTIN_AGENTS, ...customAgents];
      saveState(agents);
      return { agents };
    });
  },

  hydrateFromBackend: async (persisted) => {
    try {
      const state = persisted ?? (await loadPersistedState());
      let agents = state.agents;

      // One-time migration: if the backend has no custom agents, import from localStorage
      const hasCustomFromBackend = agents.some((a) => !a.isBuiltin);
      if (!hasCustomFromBackend) {
        const legacySaved = loadFromStorage<{ customAgents?: AgentConfig[] }>(STORAGE_KEY, {});
        const legacyCustom = (legacySaved.customAgents || []).filter((a) => !a.isBuiltin);

        // Also check for built-in overrides in localStorage
        const legacyOverrides = loadFromStorage<Record<string, Partial<AgentConfig>>>(
          OVERRIDES_KEY,
          {},
        );

        if (legacyCustom.length > 0 || Object.keys(legacyOverrides).length > 0) {
          // Merge built-in overrides into backend agents
          const mergedBuiltins = agents
            .filter((a) => a.isBuiltin)
            .map((b) => ({
              ...b,
              ...(legacyOverrides[b.id] || {}),
              id: b.id,
              isBuiltin: true as const,
            }));
          const nonBuiltins = agents.filter((a) => !a.isBuiltin);
          agents = [...mergedBuiltins, ...nonBuiltins, ...legacyCustom];

          // Persist migrated data to backend
          await saveAgentsSlice(agents);
          // Remove legacy localStorage copies
          removeFromStorage(STORAGE_KEY);
          removeFromStorage(OVERRIDES_KEY);
        }
      }

      set({ agents });
    } catch {
      // Fallback: try localStorage when backend is unavailable (dev mode)
      const legacySaved = loadFromStorage<{ customAgents?: AgentConfig[] }>(STORAGE_KEY, {});
      const legacyCustom = (legacySaved.customAgents || []).filter((a) => !a.isBuiltin);
      const legacyOverrides = loadFromStorage<Record<string, Partial<AgentConfig>>>(
        OVERRIDES_KEY,
        {},
      );

      if (legacyCustom.length > 0 || Object.keys(legacyOverrides).length > 0) {
        const builtins = BUILTIN_AGENTS.map((b) => ({
          ...b,
          ...(legacyOverrides[b.id] || {}),
          id: b.id,
          isBuiltin: true as const,
        }));
        set({ agents: [...builtins, ...legacyCustom] });
      }
    }
  },
}));
