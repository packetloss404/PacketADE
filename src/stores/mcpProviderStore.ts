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
    description: "Adds a handoff note to a task",
    inputSchema: {
      type: "object",
      properties: {
        flightId: { type: "string" },
        taskId: { type: "string" },
        summary: { type: "string" },
        filesChanged: { type: "array", items: { type: "string" } },
      },
      required: ["flightId", "taskId", "summary"],
    },
  },
  {
    name: "request_review",
    description: "Creates a review packet for a task or milestone",
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
    name: "mark_blocked",
    description: "Marks a task as blocked with a reason",
    inputSchema: {
      type: "object",
      properties: {
        flightId: { type: "string" },
        taskId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["flightId", "taskId", "reason"],
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
    if (raw) return JSON.parse(raw) as McpProviderConfig;
  } catch {
    // ignore corrupt data
  }
  return {
    enabled: false,
    port: 3100,
    allowedTools: PROVIDER_TOOLS.map((t) => t.name),
    scope: "project",
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

  setEnabled: (enabled: boolean) => void;
  setPort: (port: number) => void;
  setScope: (scope: McpProviderScope) => void;
  toggleTool: (name: string) => void;

  refreshResources: () => void;
}

export const useMcpProviderStore = create<McpProviderStore>((set, get) => ({
  config: loadConfig(),
  resources: [],
  tools: PROVIDER_TOOLS,

  setEnabled: (enabled) => {
    const config = { ...get().config, enabled };
    saveConfig(config);
    set({ config });
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
