import { create } from "zustand";
import type { Workspace, WorkspacePane, WorkspaceAgentSlot } from "@/types/workspace";
import { saveWorkspacesSlice } from "@/lib/tauri";


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

function buildPanes(agents: WorkspaceAgentSlot[]): WorkspacePane[] {
  return agents.map((agent) => ({
    id: `ws-pane-${++wsCounter}`,
    agentId: agent,
    sessionId: null,
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
  },

  deleteWorkspace: (id) => {
    set(commitWorkspaces((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id);
      const activeWorkspaceId = s.activeWorkspaceId === id ? null : s.activeWorkspaceId;
      return { workspaces, activeWorkspaceId };
    }));
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

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

  hydrateFromBackend: (workspaces) => {
    if (workspaces) {
      set({ workspaces });
    }
  },
}));
