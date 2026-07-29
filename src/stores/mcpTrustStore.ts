import { create } from "zustand";
import { storageKey } from "@/lib/brand";
import {
  mcpServerId,
  mcpServerTransport,
  type McpCapabilitySnapshot,
  type McpServerDiagnostic,
  type McpServerEntry,
  type McpTrustProfile,
  type McpTrustSnapshot,
} from "@/types/mcp";

interface McpTrustState {
  profiles: Record<string, McpTrustProfile>;
  capabilities: Record<string, McpCapabilitySnapshot>;
  setProfile: (
    server: McpServerEntry,
    patch: Partial<
      Pick<
        McpTrustProfile,
        | "allowReads"
        | "allowWrites"
        | "allowNetwork"
        | "allowedRoots"
        | "allowedToolNames"
      >
    >,
    workspacePath: string | null,
  ) => void;
  recordDiagnostic: (
    server: McpServerEntry,
    diagnostic: McpServerDiagnostic,
  ) => void;
  snapshot: (
    servers: McpServerEntry[],
    enabledNames: string[] | null,
    workspacePath: string | null,
  ) => McpTrustSnapshot[];
  clear: () => void;
}

const STORAGE_KEY = storageKey("mcp-hub-trust-v1");

type PersistedMcpTrust = Pick<McpTrustState, "profiles" | "capabilities">;

function load(): PersistedMcpTrust {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as Partial<PersistedMcpTrust>;
    return {
      profiles: parsed.profiles ?? {},
      capabilities: parsed.capabilities ?? {},
    };
  } catch {
    return { profiles: {}, capabilities: {} };
  }
}

function persist(state: PersistedMcpTrust) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best effort. Every session still gets a conservative in-memory default.
  }
}

function suspectedMutation(name: string): boolean {
  return /(?:write|create|update|delete|remove|move|rename|post|send|merge|push|publish|archive|close|reopen|assign|set|execute|run)/i.test(
    name,
  );
}

export function defaultMcpTrustProfile(
  server: McpServerEntry,
  workspacePath: string | null,
  capabilities?: McpCapabilitySnapshot,
): McpTrustProfile {
  return {
    schemaVersion: 1,
    serverId: mcpServerId(server),
    workspacePath,
    allowReads: true,
    allowWrites: false,
    allowNetwork: mcpServerTransport(server) === "stdio",
    allowedRoots: workspacePath ? [workspacePath] : [],
    allowedToolNames:
      capabilities?.tools
        .filter((tool) => !suspectedMutation(tool.name))
        .map((tool) => tool.name) ?? [],
    denialFloors: ["credentials", "outside_workspace", "protected_publish"],
    revision: 1,
    updatedAt: Date.now(),
  };
}

const initial = load();

export const useMcpTrustStore = create<McpTrustState>((set, get) => ({
  ...initial,

  setProfile: (server, patch, workspacePath) => {
    const id = mcpServerId(server);
    set((state) => {
      const current =
        state.profiles[id] ??
        defaultMcpTrustProfile(server, workspacePath, state.capabilities[id]);
      const profile: McpTrustProfile = {
        ...current,
        ...patch,
        serverId: id,
        workspacePath,
        denialFloors: current.denialFloors,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      const profiles = { ...state.profiles, [id]: profile };
      persist({ profiles, capabilities: state.capabilities });
      return { profiles };
    });
  },

  recordDiagnostic: (server, diagnostic) => {
    const id = mcpServerId(server);
    set((state) => {
      const capabilities = {
        ...state.capabilities,
        [id]: {
          schemaVersion: 1 as const,
          ...diagnostic,
        },
      };
      const current =
        state.profiles[id] ??
        defaultMcpTrustProfile(server, null, capabilities[id]);
      const profiles = state.profiles[id]
        ? state.profiles
        : { ...state.profiles, [id]: current };
      persist({ profiles, capabilities });
      return { profiles, capabilities };
    });
  },

  snapshot: (servers, enabledNames, workspacePath) =>
    servers
      .filter(
        (server) =>
          !server.disabled &&
          (enabledNames === null || enabledNames.includes(server.name)),
      )
      .map((server) => {
        const id = mcpServerId(server);
        const capability = get().capabilities[id];
        const profile =
          get().profiles[id] ??
          defaultMcpTrustProfile(server, workspacePath, capability);
        return {
          ...profile,
          workspacePath,
          serverName: server.name,
          capabilityCheckedAt: capability?.checkedAt,
        };
      }),

  clear: () => {
    set({ profiles: {}, capabilities: {} });
    persist({ profiles: {}, capabilities: {} });
  },
}));
