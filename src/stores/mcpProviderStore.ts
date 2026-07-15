import { create } from "zustand";
import type {
  McpResource,
  McpTool,
  McpProviderConfig,
  McpProviderScope,
} from "@/types/mcp-provider";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useMemoryStore } from "@/stores/memoryStore";
import {
  mcpServerStart,
  mcpServerStop,
  mcpServerStatus,
  mcpServerRecentActivity,
  type McpServerStatus,
  type McpActivityEntry,
} from "@/lib/tauri";

const ACTIVITY_CAP = 50;

/**
 * Merge activity lists deduped by `seq`, sorted most-recent-last, capped. Used
 * for BOTH the backlog fetch and the live event stream so an access carried by
 * both (the backend records + emits in one call) appears exactly once, and an
 * event that lands before the fetch resolves isn't clobbered by the fetch.
 */
export function mergeActivity(
  existing: McpActivityEntry[],
  incoming: McpActivityEntry[],
): McpActivityEntry[] {
  const bySeq = new Map<number, McpActivityEntry>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-ACTIVITY_CAP);
}

// --- Static tool definitions ---

const PROVIDER_TOOLS: McpTool[] = [
  {
    name: "get_active_flight",
    description: "Returns details of the currently active flight",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_runnable_tasks",
    description: "Lists tasks that can be launched (pending or queued)",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_task_details",
    description: "Reads a specific task by flight and task ID",
    inputSchema: {
      type: "object",
      properties: {
        flightId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["flightId", "taskId"],
    },
  },
  {
    name: "append_handoff",
    description:
      "Post an append-only handoff note to a flight's coordination timeline (human-visible; changes no state)",
    inputSchema: {
      type: "object",
      properties: {
        flightId: { type: "string" },
        summary: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["flightId", "summary"],
    },
  },
  {
    name: "escalate",
    description:
      "Flag a flight for human attention (an escalation on its coordination timeline; changes no state)",
    inputSchema: {
      type: "object",
      properties: {
        flightId: { type: "string" },
        summary: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["flightId", "summary"],
    },
  },
  {
    name: "read_memory_context",
    description: "Reads learned memory patterns for the current project",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_workspaces",
    description: "Lists active workspaces",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// --- Persistence ---

const STORAGE_KEY = "packetade:mcp-provider";

function loadConfig(): McpProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Merge over defaults so configs persisted before a field existed (e.g.
    // `allowWrites`) don't come back `undefined`.
    if (raw) return { ...defaultConfig(), ...(JSON.parse(raw) as Partial<McpProviderConfig>) };
  } catch {
    // ignore corrupt data
  }
  return defaultConfig();
}

function defaultConfig(): McpProviderConfig {
  return {
    enabled: false,
    port: 3100,
    allowedTools: PROVIDER_TOOLS.map((t) => t.name),
    scope: "project",
    allowWrites: false,
  };
}

function saveConfig(config: McpProviderConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// --- Store ---

interface McpProviderStore {
  config: McpProviderConfig;
  resources: McpResource[];
  tools: McpTool[];
  /** Live backend server status (null until first queried). */
  serverStatus: McpServerStatus | null;
  /** Set when the last start/stop attempt failed, cleared on success. */
  serverError: string | null;
  /** True while a start/stop is in flight — serializes toggles. */
  serverBusy: boolean;
  /** Recent tool/resource accesses (most-recent-last), for the viewer. */
  activity: McpActivityEntry[];

  setEnabled: (enabled: boolean) => Promise<void>;
  setPort: (port: number) => void;
  setScope: (scope: McpProviderScope) => void;
  setAllowWrites: (allowWrites: boolean) => void;
  toggleTool: (name: string) => void;

  /** Reconcile `config.enabled` with the actual backend server state. */
  syncServerStatus: () => Promise<void>;
  /** Fetch the current audit ring from the backend. */
  refreshActivity: () => Promise<void>;
  /** Append a live access (from the `mcp-server-activity` event). */
  pushActivity: (entry: McpActivityEntry) => void;
  refreshResources: () => void;
}

export const useMcpProviderStore = create<McpProviderStore>((set, get) => ({
  config: loadConfig(),
  resources: [],
  tools: PROVIDER_TOOLS,
  serverStatus: null,
  serverError: null,
  serverBusy: false,
  activity: [],

  refreshActivity: async () => {
    try {
      const fetched = await mcpServerRecentActivity();
      set((s) => ({ activity: mergeActivity(s.activity, fetched) }));
    } catch {
      // best-effort
    }
  },

  pushActivity: (entry) => {
    set((s) => ({ activity: mergeActivity(s.activity, [entry]) }));
  },

  setEnabled: async (enabled) => {
    // Serialize toggles: ignore a click while a start/stop is still resolving,
    // so start/stop can't interleave and desync config vs. the real backend.
    if (get().serverBusy) return;
    const prev = get().config;
    const config = { ...prev, enabled };
    set({ serverBusy: true, serverError: null });
    try {
      // Optimistically reflect the intent; revert if the backend rejects it.
      saveConfig(config);
      set({ config });
      const status = enabled
        ? await mcpServerStart(config.port, config.allowWrites)
        : await mcpServerStop();
      // The backend ring is per-run; a stop empties it, so mirror that here.
      set(enabled ? { serverStatus: status } : { serverStatus: status, activity: [] });
    } catch (e) {
      try {
        saveConfig(prev);
      } catch {
        // localStorage unavailable; in-memory revert still applies
      }
      set({ config: prev, serverError: String(e) });
    } finally {
      set({ serverBusy: false });
    }
  },

  syncServerStatus: async () => {
    // Don't fight an in-flight toggle — that operation is authoritative.
    if (get().serverBusy) return;
    try {
      const status = await mcpServerStatus();
      set((s) => {
        // Re-check: a toggle may have started while we awaited.
        if (s.serverBusy) return {};
        if (s.config.enabled === status.running) return { serverStatus: status };
        // Backend is authoritative: reconcile + PERSIST the stale intent
        // (e.g. `enabled:true` in localStorage after the server died on exit).
        const config = { ...s.config, enabled: status.running };
        saveConfig(config);
        return { serverStatus: status, config };
      });
    } catch {
      // best-effort; leave prior state intact
    }
  },

  setPort: (port) => {
    const config = { ...get().config, port };
    saveConfig(config);
    set({ config });
  },

  setScope: (scope) => {
    const config = { ...get().config, scope };
    saveConfig(config);
    set({ config });
  },

  setAllowWrites: (allowWrites) => {
    const config = { ...get().config, allowWrites };
    saveConfig(config);
    set({ config });
  },

  toggleTool: (name) => {
    const current = get().config.allowedTools;
    const allowedTools = current.includes(name)
      ? current.filter((t) => t !== name)
      : [...current, name];
    const config = { ...get().config, allowedTools };
    saveConfig(config);
    set({ config });
  },

  refreshResources: () => {
    const resources: McpResource[] = [];

    // Flights
    const flights = useFlightStore.getState().flights;
    for (const flight of flights) {
      resources.push({
        uri: `packetade://flights/${flight.id}`,
        name: flight.title,
        description: `Flight [${flight.status}] — ${flight.objective || "No objective"}`,
        mimeType: "application/json",
      });

      // Tasks within each flight
      for (const milestone of flight.milestones) {
        for (const task of milestone.tasks) {
          resources.push({
            uri: `packetade://flights/${flight.id}/tasks/${task.id}`,
            name: task.title,
            description: `Task [${task.status}] in ${flight.title} / ${milestone.title}`,
            mimeType: "application/json",
          });
        }
      }
    }

    // Memory patterns
    const patterns = useMemoryStore.getState().patterns;
    if (patterns.length > 0) {
      resources.push({
        uri: "packetade://memory/patterns",
        name: "Memory Patterns",
        description: `${patterns.length} learned pattern(s)`,
        mimeType: "application/json",
      });
    }

    // Workspaces
    const workspaces = useWorkspaceStore.getState().workspaces;
    for (const ws of workspaces) {
      resources.push({
        uri: `packetade://workspaces/${ws.id}`,
        name: ws.name,
        description: `Workspace — ${ws.panes.length} pane(s)`,
        mimeType: "application/json",
      });
    }

    set({ resources });
  },
}));
