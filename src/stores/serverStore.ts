import { create } from "zustand";
import { saveServersSlice } from "@/lib/tauri";
import { generateId } from "@/lib/storage";
import { logSwallowed } from "@/lib/logSwallowed";
import type { ServerConfig, ServerConnectionState, ConnectionStep } from "@/types/server";

interface ServerStore {
  servers: ServerConfig[];
  activeServerId: string | null;
  connectionStates: Record<string, ServerConnectionState>;
  /** Absolute path of the app-managed `known_hosts` file, fetched from
   *  the Rust `get_app_known_hosts_path` command at bootstrap. `null`
   *  until the call returns — `buildSshArgs` callers should pass this
   *  through unmodified so pinned-mode SSH works in production. */
  knownHostsPath: string | null;

  // CRUD
  addServer: (config: Omit<ServerConfig, "id" | "installedAgents">) => ServerConfig;
  updateServer: (id: string, updates: Partial<ServerConfig>) => void;
  deleteServer: (id: string) => void;
  setActiveServer: (id: string | null) => void;
  getServer: (id: string) => ServerConfig | undefined;

  // Connection state (ephemeral)
  setConnectionStatus: (serverId: string, state: ServerConnectionState) => void;
  updateConnectionStep: (serverId: string, stepId: string, updates: Partial<ConnectionStep>) => void;
  clearConnectionState: (serverId: string) => void;

  // Hydration
  hydrateFromBackend: (servers?: ServerConfig[]) => void;
  setKnownHostsPath: (path: string) => void;
}

function syncToBackend(servers: ServerConfig[]) {
  void saveServersSlice(servers).catch(logSwallowed("serverStore.save"));
}

export const useServerStore = create<ServerStore>((set, get) => ({
  servers: [],
  activeServerId: null,
  connectionStates: {},
  knownHostsPath: null,

  addServer: (config) => {
    const server: ServerConfig = {
      ...config,
      id: generateId("srv"),
      installedAgents: [],
    };
    set((s) => {
      const servers = [...s.servers, server];
      syncToBackend(servers);
      return { servers, activeServerId: server.id };
    });
    return server;
  },

  updateServer: (id, updates) => {
    set((s) => {
      const servers = s.servers.map((srv) =>
        srv.id === id ? { ...srv, ...updates } : srv,
      );
      syncToBackend(servers);
      return { servers };
    });
  },

  deleteServer: (id) => {
    set((s) => {
      const servers = s.servers.filter((srv) => srv.id !== id);
      const activeServerId = s.activeServerId === id ? null : s.activeServerId;
      syncToBackend(servers);
      return { servers, activeServerId };
    });
  },

  setActiveServer: (id) => set({ activeServerId: id }),

  getServer: (id) => get().servers.find((s) => s.id === id),

  setConnectionStatus: (serverId, state) => {
    set((s) => ({
      connectionStates: { ...s.connectionStates, [serverId]: state },
    }));
  },

  updateConnectionStep: (serverId, stepId, updates) => {
    set((s) => {
      const current = s.connectionStates[serverId];
      if (!current) return s;
      const steps = current.steps.map((step) =>
        step.id === stepId ? { ...step, ...updates } : step,
      );
      return {
        connectionStates: {
          ...s.connectionStates,
          [serverId]: { ...current, steps },
        },
      };
    });
  },

  clearConnectionState: (serverId) => {
    set((s) => {
      // Destructure-and-discard: `_` swallows the dropped server's state.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [serverId]: _, ...rest } = s.connectionStates;
      return { connectionStates: rest };
    });
  },

  hydrateFromBackend: (servers) => {
    if (servers) {
      set({ servers });
    }
  },

  setKnownHostsPath: (path) => set({ knownHostsPath: path }),
}));
