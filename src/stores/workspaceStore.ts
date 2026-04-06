import { create } from "zustand";
import type { Workspace, WorkspacePane, WorkspaceAgentSlot } from "@/types/workspace";
import { computeGridLayout } from "@/lib/gridLayout";

interface WorkspaceStore {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  createWorkspace: (name: string, agents: WorkspaceAgentSlot[], projectPath: string) => string;
  archiveWorkspace: (id: string) => void;
  deleteWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string | null) => void;
  getActiveWorkspace: () => Workspace | undefined;
  setPaneSession: (workspaceId: string, paneId: string, sessionId: string | null) => void;
  hydrateFromBackend: (workspaces?: Workspace[]) => void;
}

let wsCounter = 0;

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

  createWorkspace: (name, agents, projectPath) => {
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
    };
    set((s) => {
      const workspaces = [...s.workspaces, workspace];
      syncToBackend(workspaces);
      return { workspaces, activeWorkspaceId: id };
    });
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
