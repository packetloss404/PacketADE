import { create } from "zustand";
import { saveServersSlice } from "@/lib/tauri";
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
  updateServer: (id: string, updates: Partial<ServerConfig>) => void;
  addServerPersisted: (
    config: Omit<ServerConfig, "id" | "installedAgents">,
    id: string,
  ) => Promise<ServerConfig>;
  updateServerPersisted: (id: string, updates: Partial<ServerConfig>) => Promise<ServerConfig>;
  deleteServerRecordPersisted: (id: string) => Promise<ServerConfig>;
  restoreServerRecordPersisted: (server: ServerConfig) => Promise<void>;
  setActiveServer: (id: string | null) => void;
  getServer: (id: string) => ServerConfig | undefined;

  // Connection state (ephemeral)
  setConnectionStatus: (serverId: string, state: ServerConnectionState) => void;
  updateConnectionStep: (
    serverId: string,
    stepId: string,
    updates: Partial<ConnectionStep>,
  ) => void;
  clearConnectionState: (serverId: string) => void;

  // Hydration
  hydrateFromBackend: (servers?: ServerConfig[]) => void;
  setKnownHostsPath: (path: string) => void;
}

let serverWriteQueue: Promise<void> = Promise.resolve();

function queueServerWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = serverWriteQueue.then(operation);
  serverWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function syncToBackend(servers: ServerConfig[]) {
  void queueServerWrite(() => saveServersSlice(servers)).catch(logSwallowed("serverStore.save"));
}

export const useServerStore = create<ServerStore>((set, get) => ({
  servers: [],
  activeServerId: null,
  connectionStates: {},
  knownHostsPath: null,

  updateServer: (id, updates) => {
    set((s) => {
      const servers = s.servers.map((srv) => (srv.id === id ? { ...srv, ...updates } : srv));
      syncToBackend(servers);
      return { servers };
    });
  },

  addServerPersisted: (config, id) =>
    queueServerWrite(async () => {
      if (get().servers.some((server) => server.id === id)) {
        throw new Error(`A remote server with id '${id}' already exists.`);
      }
      const server: ServerConfig = { ...config, id, installedAgents: [] };
      const servers = [...get().servers, server];
      await saveServersSlice(servers);
      set({ servers, activeServerId: id });
      return server;
    }),

  updateServerPersisted: (id, updates) =>
    queueServerWrite(async () => {
      const current = get().servers.find((server) => server.id === id);
      if (!current) throw new Error(`Remote server '${id}' no longer exists.`);
      const updated = { ...current, ...updates };
      const servers = get().servers.map((server) => (server.id === id ? updated : server));
      await saveServersSlice(servers);
      set({ servers });
      return updated;
    }),

  deleteServerRecordPersisted: (id) =>
    queueServerWrite(async () => {
      const current = get().servers.find((server) => server.id === id);
      if (!current) throw new Error(`Remote server '${id}' no longer exists.`);
      const servers = get().servers.filter((server) => server.id !== id);
      await saveServersSlice(servers);
      set({
        servers,
        activeServerId: get().activeServerId === id ? null : get().activeServerId,
      });
      return current;
    }),

  restoreServerRecordPersisted: (server) =>
    queueServerWrite(async () => {
      const withoutDuplicate = get().servers.filter((candidate) => candidate.id !== server.id);
      const servers = [...withoutDuplicate, server];
      await saveServersSlice(servers);
      set({ servers });
    }),

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
