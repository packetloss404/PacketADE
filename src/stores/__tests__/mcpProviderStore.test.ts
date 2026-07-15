import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpServerStatus, McpActivityEntry } from "@/lib/tauri";

const mockStart = vi.fn();
const mockStop = vi.fn();
const mockStatus = vi.fn();

vi.mock("@/lib/tauri", () => ({
  mcpServerStart: (...a: unknown[]) => mockStart(...a),
  mcpServerStop: (...a: unknown[]) => mockStop(...a),
  mcpServerStatus: (...a: unknown[]) => mockStatus(...a),
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

import { useMcpProviderStore, mergeActivity } from "@/stores/mcpProviderStore";

const STORAGE_KEY = "packetade:mcp-provider";

function persistedEnabled(): boolean {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").enabled === true;
}

function reset() {
  localStorage.clear();
  useMcpProviderStore.setState({
    config: { enabled: false, port: 3100, allowedTools: [], scope: "project", allowWrites: false },
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
};
const STOPPED: McpServerStatus = {
  running: false,
  port: null,
  token: null,
  url: null,
  allowWrites: false,
};

describe("mcpProviderStore server lifecycle", () => {
  beforeEach(() => {
    reset();
    mockStart.mockReset();
    mockStop.mockReset();
    mockStatus.mockReset();
  });

  it("setEnabled(true) starts the backend, stores status, and persists", async () => {
    mockStart.mockResolvedValue(RUNNING);
    await useMcpProviderStore.getState().setEnabled(true);
    expect(mockStart).toHaveBeenCalledWith(3100, false);
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
      allowedTools: [],
      scope: "project" as const,
      allowWrites: false,
    };
    useMcpProviderStore.setState({ config: stale });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
    mockStatus.mockResolvedValue(STOPPED);

    await useMcpProviderStore.getState().syncServerStatus();

    expect(useMcpProviderStore.getState().config.enabled).toBe(false);
    expect(persistedEnabled()).toBe(false); // reconciled value survives reload
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
