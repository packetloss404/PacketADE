import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpServerStatus, McpActivityEntry } from "@/lib/tauri";

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockStatus = vi.fn();
const mockAvailableTools = vi.fn();

vi.mock("@/lib/tauri", () => ({
  mcpServerStart: (...a: unknown[]) => mockStart(...a),
  mcpServerStop: (...a: unknown[]) => mockStop(...a),
  mcpServerStatus: (...a: unknown[]) => mockStatus(...a),
  mcpServerRecentActivity: () => Promise.resolve([]),
  mcpServerAvailableTools: (...a: unknown[]) => mockAvailableTools(...a),
}));

// Isolate from the real stores' dependency graphs (only used by refreshResources).
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: { getState: () => ({ flights: [] }) },
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ workspaces: [] }) },
}));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: () => ({ patterns: [] }) },
}));

import {
  useMcpProviderStore,
  mergeActivity,
  loadPersistedProviderConfig,
} from "@/stores/mcpProviderStore";

const STORAGE_KEY = "packetbench:mcp-provider";

function persistedEnabled(): boolean {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").enabled === true;
}

function reset() {
  localStorage.clear();
  useMcpProviderStore.setState({
    config: { enabled: false, port: 3100, allowedTools: null, allowWrites: false },
    tools: [],
    serverStatus: null,
    serverError: null,
    serverBusy: false,
  });
}

const RUNNING: McpServerStatus = {
  running: true,
  port: 3100,
  token: "tok",
  url: "http://127.0.0.1:3100/mcp",
  allowWrites: false,
  servedTools: [],
};
const STOPPED: McpServerStatus = {
  running: false,
  port: null,
  token: null,
  url: null,
  allowWrites: false,
  servedTools: [],
};

describe("mcpProviderStore server lifecycle", () => {
  beforeEach(() => {
    reset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockStatus.mockReset();
    mockAvailableTools.mockReset();
  });

  it("setEnabled(true) starts the backend, stores status, and persists", async () => {
    mockStart.mockResolvedValue(RUNNING);
    await useMcpProviderStore.getState().setEnabled(true);
    // The allowlist MUST reach the backend — it was previously dropped here,
    // which is what made the setting dead config.
    expect(mockStart).toHaveBeenCalledWith(3100, false, null);
    const s = useMcpProviderStore.getState();
    expect(s.config.enabled).toBe(true);
    expect(s.serverStatus?.token).toBe("tok");
    expect(s.serverBusy).toBe(false);
    expect(persistedEnabled()).toBe(true);
  });

  it("reverts config and persists the revert on start failure", async () => {
    mockStart.mockRejectedValue(new Error("port in use"));
    await useMcpProviderStore.getState().setEnabled(true);
    const s = useMcpProviderStore.getState();
    expect(s.config.enabled).toBe(false);
    expect(s.serverError).toContain("port in use");
    expect(persistedEnabled()).toBe(false);
  });

  it("busy guard ignores a concurrent toggle while a start is in flight", async () => {
    let resolve: ((v: McpServerStatus) => void) | undefined;
    mockStart.mockReturnValue(
      new Promise<McpServerStatus>((r) => {
        resolve = r;
      }),
    );
    const inFlight = useMcpProviderStore.getState().setEnabled(true);
    // Second toggle arrives before the first resolves — must be dropped.
    await useMcpProviderStore.getState().setEnabled(false);
    expect(mockStop).not.toHaveBeenCalled();
    resolve?.(RUNNING);
    await inFlight;
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("syncServerStatus reconciles AND persists a stale enabled flag", async () => {
    // Simulate a restart: localStorage says enabled but the server isn't running.
    const stale = {
      enabled: true,
      port: 3100,
      allowedTools: null,
      allowWrites: false,
    };
    useMcpProviderStore.setState({ config: stale });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
    mockStatus.mockResolvedValue(STOPPED);

    await useMcpProviderStore.getState().syncServerStatus();

    expect(useMcpProviderStore.getState().config.enabled).toBe(false);
    expect(persistedEnabled()).toBe(false); // reconciled value survives reload
  });

  it("publishes stable suite resources for Issues and PacketCode health", () => {
    useMcpProviderStore.getState().refreshResources();
    expect(useMcpProviderStore.getState().resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "packetbench://issues" }),
        expect.objectContaining({ uri: "packetbench://packetcode/health" }),
      ]),
    );
  });
});

describe("mergeActivity", () => {
  const e = (seq: number): McpActivityEntry => ({
    seq,
    kind: "tool",
    name: `t${seq}`,
    at: 1000 + seq,
  });

  it("dedupes by seq (backlog + live overlap shows once)", () => {
    // Backlog fetched [1,2,3]; live event re-delivers 3 and adds 4.
    const merged = mergeActivity([e(1), e(2), e(3)], [e(3), e(4)]);
    expect(merged.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });

  it("keeps an event that landed before the fetch (no loss)", () => {
    // Live event 5 pushed first, then backlog fetch [1,2] resolves.
    const afterPush = mergeActivity([], [e(5)]);
    const afterFetch = mergeActivity(afterPush, [e(1), e(2)]);
    expect(afterFetch.map((x) => x.seq)).toEqual([1, 2, 5]);
  });

  it("sorts most-recent-last and caps at 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => e(i));
    const merged = mergeActivity([], many);
    expect(merged).toHaveLength(50);
    expect(merged[0].seq).toBe(10);
    expect(merged[49].seq).toBe(59);
  });
});

describe("mcpProviderStore per-tool allowlist", () => {
  beforeEach(() => {
    reset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockStatus.mockReset();
    mockAvailableTools.mockReset();
  });

  const CATALOGUE = [
    { name: "ping", description: "Health check" },
    { name: "get_active_flight", description: "Active flight" },
    { name: "append_handoff", description: "Handoff note" },
  ];

  it("reads the tool catalogue from the backend rather than a hardcoded copy", async () => {
    mockAvailableTools.mockResolvedValue(CATALOGUE);
    await useMcpProviderStore.getState().syncAvailableTools();
    expect(useMcpProviderStore.getState().tools.map((t) => t.name)).toEqual([
      "ping",
      "get_active_flight",
      "append_handoff",
    ]);
  });

  it("claims no catalogue at all when the backend cannot be read", async () => {
    // A guessed catalogue is exactly the drift this replaced — an unreadable
    // backend must leave the list empty, not substitute a stale list.
    mockAvailableTools.mockRejectedValue(new Error("no backend"));
    await useMcpProviderStore.getState().syncAvailableTools();
    expect(useMcpProviderStore.getState().tools).toEqual([]);
  });

  it("sends the chosen allowlist to the backend on start", async () => {
    mockAvailableTools.mockResolvedValue(CATALOGUE);
    mockStart.mockResolvedValue(RUNNING);
    await useMcpProviderStore.getState().syncAvailableTools();
    // Turning one tool off must materialize the implicit "all" first, so the
    // other two stay allowed rather than becoming the only denied ones.
    useMcpProviderStore.getState().toggleTool("append_handoff");
    await useMcpProviderStore.getState().setEnabled(true);
    expect(mockStart).toHaveBeenCalledWith(3100, false, ["ping", "get_active_flight"]);
  });

  it("sends an empty allowlist as an answer, not as an absence", async () => {
    mockAvailableTools.mockResolvedValue(CATALOGUE);
    mockStart.mockResolvedValue(RUNNING);
    await useMcpProviderStore.getState().syncAvailableTools();
    for (const tool of CATALOGUE) useMcpProviderStore.getState().toggleTool(tool.name);
    await useMcpProviderStore.getState().setEnabled(true);
    // `[]` means serve nothing. Collapsing it to `null` would fail OPEN on the
    // strictest setting the card offers.
    expect(mockStart).toHaveBeenCalledWith(3100, false, []);
  });

  it("drops allowlist entries the backend does not actually serve", async () => {
    useMcpProviderStore.setState({
      config: {
        enabled: false,
        port: 3100,
        allowedTools: ["ping", "a_tool_that_was_removed"],
        allowWrites: false,
      },
    });
    mockAvailableTools.mockResolvedValue(CATALOGUE);
    await useMcpProviderStore.getState().syncAvailableTools();
    expect(useMcpProviderStore.getState().config.allowedTools).toEqual(["ping"]);
  });

  it("keeps an allowlist that was written AFTER enforcement landed", () => {
    // A post-enforcement write is a real decision and must survive a reload,
    // otherwise the restriction quietly lapses on every restart.
    useMcpProviderStore.setState({
      config: { enabled: false, port: 3100, allowedTools: null, allowWrites: false },
      tools: CATALOGUE.map((t) => ({ ...t, inputSchema: {} })),
    });
    useMcpProviderStore.getState().toggleTool("append_handoff");
    expect(loadPersistedProviderConfig().allowedTools).toEqual([
      "ping",
      "get_active_flight",
    ]);
  });

  it("treats a pre-enforcement persisted allowlist as undecided", () => {
    // Those values were written from a hardcoded catalogue that had already
    // drifted (no `ping`, no inbox tools) and never restricted anything.
    // Enforcing them now would newly switch off working tools, so they are
    // discarded — observed behaviour preserved, later toggles real.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: false,
        port: 3100,
        allowedTools: ["get_active_flight"],
        scope: "project",
        allowWrites: false,
      }),
    );
    const config = loadPersistedProviderConfig();
    expect(config.allowedTools).toBeNull();
    expect("scope" in config).toBe(false);
  });
});
