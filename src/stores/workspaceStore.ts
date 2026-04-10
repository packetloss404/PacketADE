import { create } from "zustand";
import type { Workspace, WorkspacePane, WorkspaceAgentSlot } from "@/types/workspace";
import { computeGridLayout } from "@/lib/gridLayout";

export interface WorkspaceSessionConfig {
  prompt?: string;
  profileId?: string;
  modelOverrides?: Record<string, string | null>;
  includeMemory?: boolean;
  bypassPermissions?: boolean;
}

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  keepTerminalsAlive: boolean;

  createWorkspace: (name: string, agents: WorkspaceAgentSlot[], projectPath: string, sessionConfig?: WorkspaceSessionConfig) => string;
  archiveWorkspace: (id: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  getActiveWorkspace: () => Workspace | undefined;
  setPaneSession: (workspaceId: string, paneId: string, sessionId: string | null) => void;
  setKeepTerminalsAlive: (keep: boolean) => void;
  hydrateFromBackend: (workspaces?: Workspace[]) => void;
}

const KEEP_ALIVE_KEY = "packetcode:workspace-keep-alive";

let wsCounter = 0;

// Ephemeral map of workspace ID → session config, consumed once when WorkspaceView launches panes.
const pendingSessionConfigs = new Map<string, WorkspaceSessionConfig>();

export function consumePendingSessionConfig(workspaceId: string): WorkspaceSessionConfig | undefined {
  const config = pendingSessionConfigs.get(workspaceId);
  if (config) pendingSessionConfigs.delete(workspaceId);
  return config;
}

function buildPanes(agents: WorkspaceAgentSlot[]): WorkspacePane[] {
  const layout = computeGridLayout(agents.length);
  return layout.cells
    .filter((cell) => cell.agentIndex !== null)
    .map((cell) => ({
      id: `ws-pane-${++wsCounter}`,
      agentId: agents[cell.agentIndex!],
      sessionId: null,
      gridPosition: { row: cell.row, col: cell.col },
    }));
}

function syncToBackend(workspaces: Workspace[]) {
  import("@/lib/tauri").then(({ saveWorkspacesSlice }) => {
    saveWorkspacesSlice(workspaces).catch(() => {});
  });
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  keepTerminalsAlive: typeof localStorage !== "undefined" && localStorage.getItem(KEEP_ALIVE_KEY) === "true",

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
      createdAt: now,
      updatedAt: now,
      status: "active",
      bypassPermissions: sessionConfig?.bypassPermissions ?? false,
    };
    set((s) => {
      const workspaces = [...s.workspaces, workspace];
      syncToBackend(workspaces);
      return { workspaces, activeWorkspaceId: id };
    });

    // If session config provided, store it for WorkspaceView to pick up when launching panes
    if (sessionConfig) {
      pendingSessionConfigs.set(id, sessionConfig);
    }

    return id;
  },

  archiveWorkspace: (id) => {
    set((s) => {
      const workspaces = s.workspaces.map((w) =>
        w.id === id ? { ...w, status: "archived" as const, updatedAt: Date.now() } : w
      );
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      syncToBackend(workspaces);
      return { workspaces, activeWorkspaceId };
    });
  },

  deleteWorkspace: (id) => {
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      syncToBackend(workspaces);
      return { workspaces, activeWorkspaceId };
    });
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

  getActiveWorkspace: () => {
    const s = get();
    return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  },

  setPaneSession: (workspaceId, paneId, sessionId) => {
    set((s) => {
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
      syncToBackend(workspaces);
      return { workspaces };
    });
  },

  hydrateFromBackend: (workspaces) => {
    if (workspaces) {
      set({ workspaces });
    }
  },
}));
