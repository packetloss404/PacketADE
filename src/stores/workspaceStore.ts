import { create } from "zustand";
import type { Workspace, WorkspacePane, WorkspaceAgentSlot } from "@/types/workspace";
import { saveWorkspacesSlice } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";


export interface WorkspaceSessionConfig {
  prompt?: string;
  modelOverrides?: Record<string, string | null>;
  effortOverrides?: Record<string, string | null>;
  bypassPermissions?: boolean;
  serverId?: string;
  remoteProjectPath?: string;
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  keepTerminalsAlive: boolean;
  zoomedPaneId: string | null;

  createWorkspace: (name: string, agents: WorkspaceAgentSlot[], projectPath: string, sessionConfig?: WorkspaceSessionConfig) => string;
  archiveWorkspace: (id: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  getActiveWorkspace: () => Workspace | undefined;
  setPaneSession: (workspaceId: string, paneId: string, sessionId: string | null) => void;
  updatePane: (workspaceId: string, paneId: string, updates: Partial<WorkspacePane>) => void;
  addPinnedCommand: (workspaceId: string, paneId: string, command: string) => void;
  setModelOverride: (workspaceId: string, agentId: string, model: string | null) => void;
  removePinnedCommand: (workspaceId: string, paneId: string, index: number) => void;
  addPane: (workspaceId: string, agentId: WorkspaceAgentSlot) => string | null;
  removePane: (workspaceId: string, paneId: string) => void;
  setKeepTerminalsAlive: (keep: boolean) => void;
  setZoomedPane: (paneId: string | null) => void;
  hydrateFromBackend: (workspaces?: Workspace[]) => void;
}

const KEEP_ALIVE_KEY = "packetade:workspace-keep-alive";

const PANE_COLORS = ["accent-green", "accent-blue", "accent-amber", "accent-purple", "accent-red", "accent-cyan"];

let wsCounter = 0;

function buildPanes(agents: WorkspaceAgentSlot[]): WorkspacePane[] {
  return agents.map((agent, index) => ({
    id: `ws-pane-${++wsCounter}`,
    agentId: agent,
    sessionId: null,
    accentColor: PANE_COLORS[index % PANE_COLORS.length],
  }));
}

function syncToBackend(workspaces: Workspace[]) {
  saveWorkspacesSlice(workspaces).catch(() => {});
}

function commitWorkspaces(
  updater: (state: Pick<WorkspaceStore, "workspaces" | "activeWorkspaceId">) => Partial<WorkspaceStore>,
) {
  return (state: WorkspaceStore): Partial<WorkspaceStore> => {
    const next = updater(state);
    if (next.workspaces) {
      syncToBackend(next.workspaces);
    }
    return next;
  };
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  keepTerminalsAlive: typeof localStorage !== "undefined" && localStorage.getItem(KEEP_ALIVE_KEY) === "true",
  zoomedPaneId: null,

  setKeepTerminalsAlive: (keep) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEEP_ALIVE_KEY, String(keep));
    }
    set({ keepTerminalsAlive: keep });
  },

  createWorkspace: (name, agents, projectPath, sessionConfig) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const workspace: Workspace = {
      id,
      name,
      agents,
      panes: buildPanes(agents),
      projectPath,
      prompt: sessionConfig?.prompt,
      createdAt: now,
      updatedAt: now,
      status: "active",
      bypassPermissions: sessionConfig?.bypassPermissions ?? false,
      modelOverrides: sessionConfig?.modelOverrides,
      effortOverrides: sessionConfig?.effortOverrides,
      serverId: sessionConfig?.serverId,
      remoteProjectPath: sessionConfig?.remoteProjectPath,
    };
    set(commitWorkspaces((s) => {
      const workspaces = [...s.workspaces, workspace];
      return { workspaces, activeWorkspaceId: id };
    }));
    return id;
  },

  archiveWorkspace: (id) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) =>
        w.id === id ? { ...w, status: "archived" as const, updatedAt: Date.now() } : w
      );
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    }));
    // Detach (don't cascade-delete) any conversations soft-bound to this
    // workspace so they survive as one-off agents in the sidebar.
    void import("@/stores/agentTaskStore").then(({ useAgentTaskStore }) => {
      useAgentTaskStore.getState().detachConversationsFromWorkspace(id);
    });
  },

  deleteWorkspace: (id) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    }));
    void import("@/stores/agentTaskStore").then(({ useAgentTaskStore }) => {
      useAgentTaskStore.getState().detachConversationsFromWorkspace(id);
    });
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    if (id) {
      const workspace = get().workspaces.find((w) => w.id === id);
      if (workspace) {
        useLayoutStore.getState().setProjectPath(workspace.projectPath);
      }
    }
  },

  getActiveWorkspace: () => {
    const s = get();
    return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  },

  setPaneSession: (workspaceId, paneId, sessionId) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) =>
            p.id === paneId ? { ...p, sessionId } : p
          ),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  updatePane: (workspaceId, paneId, updates) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) =>
            p.id === paneId ? { ...p, ...updates } : p
          ),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  setModelOverride: (workspaceId, agentId, model) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const overrides = { ...(w.modelOverrides ?? {}) };
        if (model === null) {
          delete overrides[agentId];
        } else {
          overrides[agentId] = model;
        }
        return { ...w, modelOverrides: overrides, updatedAt: Date.now() };
      });
      return { workspaces };
    }));
  },

  addPinnedCommand: (workspaceId, paneId, command) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) => {
            if (p.id !== paneId) return p;
            const existing = p.pinnedCommands ?? [];
            if (existing.includes(trimmed)) return p;
            if (existing.length >= 5) return p;
            return { ...p, pinnedCommands: [...existing, trimmed] };
          }),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  removePinnedCommand: (workspaceId, paneId, index) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        return {
          ...w,
          panes: w.panes.map((p) => {
            if (p.id !== paneId) return p;
            const existing = p.pinnedCommands ?? [];
            return { ...p, pinnedCommands: existing.filter((_, i) => i !== index) };
          }),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
  },

  addPane: (workspaceId, agentId) => {
    const newPaneId = `ws-pane-${++wsCounter}`;
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    const colorIndex = ws ? ws.panes.length : 0;
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const newPane: WorkspacePane = {
          id: newPaneId,
          agentId,
          sessionId: null,
          accentColor: PANE_COLORS[colorIndex % PANE_COLORS.length],
        };
        return {
          ...w,
          agents: [...w.agents, agentId],
          panes: [...w.panes, newPane],
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
    return newPaneId;
  },

  removePane: (workspaceId, paneId) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const pane = w.panes.find((p) => p.id === paneId);
        if (!pane) return w;
        return {
          ...w,
          panes: w.panes.filter((p) => p.id !== paneId),
          agents: (() => {
            // Remove one occurrence of this agent from the agents list
            const idx = w.agents.indexOf(pane.agentId);
            if (idx === -1) return w.agents;
            const copy = [...w.agents];
            copy.splice(idx, 1);
            return copy;
          })(),
          updatedAt: Date.now(),
        };
      });
      return { workspaces };
    }));
    // Clear zoom if the zoomed pane was removed
    if (get().zoomedPaneId === paneId) {
      set({ zoomedPaneId: null });
    }
  },

  setZoomedPane: (paneId) => {
    set({ zoomedPaneId: paneId });
  },

  hydrateFromBackend: (workspaces) => {
    if (workspaces) {
      set({ workspaces });
    }
  },
}));
