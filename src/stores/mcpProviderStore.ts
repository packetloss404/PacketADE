import { create } from "zustand";
import type { McpResource, McpTool, McpProviderConfig } from "@/types/mcp-provider";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { isLocalWorkspace } from "@/types/workspace";
import { useMemoryStore } from "@/stores/memoryStore";
import { APP_NAME, URI_SCHEME, storageKey } from "@/lib/brand";
import {
  mcpServerStart,
  mcpServerStop,
  mcpServerStatus,
  mcpServerRecentActivity,
  mcpServerAvailableTools,
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

// --- Tool catalogue ---

/**
 * FAULT this replaces: the tool catalogue used to be a hardcoded list right
 * here, and it had drifted from the Rust router — it never listed `ping` or
 * the three coordination-inbox tools. That was harmless while `allowedTools`
 * was dead config. Now that the router enforces the allowlist, a stale
 * catalogue would silently switch off tools the user had been using, so the
 * real list is fetched from the backend (`syncAvailableTools`).
 *
 * This fallback is deliberately EMPTY rather than a best guess: an incomplete
 * guess is exactly the failure mode being fixed, and an empty catalogue
 * renders as "reading…" instead of as a confidently wrong answer.
 */
const FALLBACK_TOOLS: McpTool[] = [];

/**
 * Resolve the allowlist to the concrete list of names to send to the backend.
 *
 * `null` = the user has made no per-tool decision, so serve everything, which
 * is the pre-enforcement behaviour. The backend reads `null` the same way.
 */
export function effectiveAllowedTools(config: McpProviderConfig): string[] | null {
  return config.allowedTools;
}

/**
 * Reconcile a persisted allowlist against the catalogue the backend actually
 * serves. Names the router does not define are dropped: they can never be
 * granted, and keeping them would make the card show a toggle for a tool that
 * does not exist.
 */
export function reconcileAllowedTools(
  allowed: string[] | null,
  catalogue: McpTool[],
): string[] | null {
  if (allowed === null) return null;
  const known = new Set(catalogue.map((t) => t.name));
  return allowed.filter((name) => known.has(name));
}

// --- Persistence ---

const STORAGE_KEY = storageKey("mcp-provider");

/**
 * Bumped when `allowedTools` became a real, enforced restriction. A persisted
 * config without this marker predates enforcement, so its `allowedTools` is a
 * stale catalogue snapshot rather than a user decision — see the migration in
 * `loadPersistedProviderConfig`.
 */
const PROVIDER_CONFIG_VERSION = 2;

export function loadPersistedProviderConfig(): McpProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Merge over defaults so configs persisted before a field existed (e.g.
    // `allowWrites`) don't come back `undefined`.
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<McpProviderConfig> & {
        scope?: unknown;
        schemaVersion?: unknown;
      };
      // `scope` was removed rather than enforced — discard whatever was
      // persisted so it cannot be read back as if it still meant something.
      delete parsed.scope;
      const wasEnforced = parsed.schemaVersion === PROVIDER_CONFIG_VERSION;
      delete parsed.schemaVersion;
      const merged = { ...defaultConfig(), ...parsed };
      // A pre-enforcement `allowedTools` is a STALE CATALOGUE SNAPSHOT, not a
      // decision: it was written from a hardcoded list that had already
      // drifted from the router, and it never restricted anything. Honouring
      // it now would newly switch off tools (`ping`, the inbox tools) that
      // have been working all along. Anything written before enforcement
      // existed is therefore treated as undecided — observed behaviour is
      // preserved exactly, and every toggle from here on is real.
      if (!wasEnforced || !Array.isArray(merged.allowedTools)) merged.allowedTools = null;
      return merged;
    }
  } catch {
    // ignore corrupt data
  }
  return defaultConfig();
}

function defaultConfig(): McpProviderConfig {
  return {
    enabled: false,
    port: 3100,
    allowedTools: null,
    allowWrites: false,
  };
}

function saveConfig(config: McpProviderConfig) {
  // Stamp the version so a later load can tell a real decision from a
  // pre-enforcement leftover.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...config, schemaVersion: PROVIDER_CONFIG_VERSION }),
  );
}

// --- Store ---

interface McpProviderStore {
  config: McpProviderConfig;
  resources: McpResource[];
  /** The catalogue the Rust router actually defines. Empty until fetched. */
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
  setAllowWrites: (allowWrites: boolean) => void;
  toggleTool: (name: string) => void;

  /** Read the canonical tool catalogue from the backend and reconcile. */
  syncAvailableTools: () => Promise<void>;
  /** Reconcile `config.enabled` with the actual backend server state. */
  syncServerStatus: () => Promise<void>;
  /** Fetch the current audit ring from the backend. */
  refreshActivity: () => Promise<void>;
  /** Append a live access (from the `mcp-server-activity` event). */
  pushActivity: (entry: McpActivityEntry) => void;
  refreshResources: () => void;
}

export const useMcpProviderStore = create<McpProviderStore>((set, get) => ({
  config: loadPersistedProviderConfig(),
  resources: [],
  tools: FALLBACK_TOOLS,
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

  syncAvailableTools: async () => {
    try {
      const fetched = await mcpServerAvailableTools();
      const tools: McpTool[] = fetched.map((t) => ({
        name: t.name,
        description: t.description,
        // The provider card only needs name + description; the router owns the
        // real schemas and the UI never renders them.
        inputSchema: {},
      }));
      set((s) => {
        const allowedTools = reconcileAllowedTools(s.config.allowedTools, tools);
        if (allowedTools === s.config.allowedTools) return { tools };
        const config = { ...s.config, allowedTools };
        try {
          saveConfig(config);
        } catch {
          // localStorage unavailable; in-memory reconcile still applies
        }
        return { tools, config };
      });
    } catch {
      // Best-effort: leave the previous catalogue in place. Notably we do NOT
      // substitute a guess — a wrong catalogue is what this replaced.
    }
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
        ? await mcpServerStart(config.port, config.allowWrites, effectiveAllowedTools(config))
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

  setAllowWrites: (allowWrites) => {
    const config = { ...get().config, allowWrites };
    saveConfig(config);
    set({ config });
  },

  toggleTool: (name) => {
    const state = get();
    // `null` means "no decision — everything is served". The first toggle has
    // to materialize that into a concrete list before it can subtract from it,
    // otherwise turning one tool off would read as turning only that tool ON.
    const current = state.config.allowedTools ?? state.tools.map((t) => t.name);
    const allowedTools = current.includes(name)
      ? current.filter((t) => t !== name)
      : [...current, name];
    const config = { ...state.config, allowedTools };
    saveConfig(config);
    set({ config });
  },

  refreshResources: () => {
    const resources: McpResource[] = [];

    resources.push({
      uri: `${URI_SCHEME}://issues`,
      name: "Issue board",
      description: `Current ${APP_NAME} issues and workflow state`,
      mimeType: "application/json",
    });
    resources.push({
      uri: `${URI_SCHEME}://packetcode/health`,
      name: "PacketCode integration health",
      description: "Availability, doctor status, home, version, and provider summary",
      mimeType: "application/json",
    });

    // Flights
    const flights = useFlightStore.getState().flights;
    for (const flight of flights) {
      resources.push({
        uri: `${URI_SCHEME}://flights/${flight.id}`,
        name: flight.title,
        description: `Flight [${flight.status}] — ${flight.objective || "No objective"}`,
        mimeType: "application/json",
      });

      // Tasks within each flight
      for (const milestone of flight.milestones) {
        for (const task of milestone.tasks) {
          resources.push({
            uri: `${URI_SCHEME}://flights/${flight.id}/tasks/${task.id}`,
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
        uri: `${URI_SCHEME}://memory/patterns`,
        name: "Memory Patterns",
        description: `${patterns.length} learned pattern(s)`,
        mimeType: "application/json",
      });
    }

    for (const workspace of useWorkspaceStore.getState().workspaces) {
      if (!isLocalWorkspace(workspace)) continue;
      resources.push({
        uri: `${URI_SCHEME}://memory/project/${workspace.id}`,
        name: `${workspace.name} Project Memory`,
        description: "Version-controlled-capable Markdown notes",
        mimeType: "application/json",
      });
    }

    // Workspaces
    const workspaces = useWorkspaceStore.getState().workspaces;
    for (const ws of workspaces) {
      resources.push({
        uri: `${URI_SCHEME}://workspaces/${ws.id}`,
        name: ws.name,
        description: `Workspace — ${ws.panes.length} pane(s)`,
        mimeType: "application/json",
      });
    }

    set({ resources });
  },
}));
