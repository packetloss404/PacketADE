import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Flight } from "@/types/flight";
import type { PersistedState } from "@/lib/tauri";

// === Mocks ===

const mockLoadPersistedState = vi.fn();
const mockSaveFlightsSlice = vi.fn().mockResolvedValue(undefined);
const mockSaveUiSlice = vi.fn().mockResolvedValue(undefined);
const mockSaveIssuesSlice = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/tauri", () => ({
  loadPersistedState: (...args: unknown[]) => mockLoadPersistedState(...args),
  saveFlightsSlice: (...args: unknown[]) => mockSaveFlightsSlice(...args),
  saveUiSlice: (...args: unknown[]) => mockSaveUiSlice(...args),
  saveIssuesSlice: (...args: unknown[]) => mockSaveIssuesSlice(...args),
}));

vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: {
    getState: vi.fn().mockReturnValue({
      resolveForTask: vi
        .fn()
        .mockReturnValue({ agentConfigId: "claude-code", model: undefined }),
    }),
  },
}));

vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: vi.fn().mockReturnValue({
      issues: [],
      assignToFlight: vi.fn(),
    }),
  },
}));

// --- Helpers ---

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: `flight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "Test Flight",
    objective: "Test objective",
    status: "draft",
    priority: "medium",
    projectPath: "/tmp/test",
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makePersistedState(flights: Flight[]): PersistedState {
  return {
    version: 1,
    flights,
    agents: [],
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: "/tmp/test",
    },
    ui: {
      selectedFlightId: null,
      selectedView: null,
      theme: null,
    },
    workspaces: [],
    memoryEvents: [],
    servers: [],
  };
}

// --- Tests ---

describe("flightStore backend persistence", () => {
  beforeEach(async () => {
    // Clear localStorage
    localStorage.clear();
    // Reset all mocks
    vi.clearAllMocks();
    mockSaveFlightsSlice.mockResolvedValue(undefined);
    mockSaveUiSlice.mockResolvedValue(undefined);
    mockLoadPersistedState.mockReset();

    // Re-import flightStore fresh by resetting the module registry
    vi.resetModules();
  });

  async function getStore() {
    const mod = await import("@/stores/flightStore");
    return mod.useFlightStore;
  }

  it("loads from backend on hydrate", async () => {
    const backendFlight = makeFlight({ id: "flight_backend_1", title: "Backend Flight" });
    mockLoadPersistedState.mockResolvedValue(makePersistedState([backendFlight]));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(1);
    expect(flights[0].id).toBe("flight_backend_1");
    expect(flights[0].title).toBe("Backend Flight");
  });

  it("uses backend state when backend is empty", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState([]));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(0);
  });

  it("prefers backend state when backend has data", async () => {
    const backendFlights = [
      makeFlight({ id: "flight_b1", title: "Backend 1" }),
      makeFlight({ id: "flight_b2", title: "Backend 2" }),
      makeFlight({ id: "flight_b3", title: "Backend 3" }),
    ];
    mockLoadPersistedState.mockResolvedValue(makePersistedState(backendFlights));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(3);
    expect(flights.map((f) => f.id)).toEqual(["flight_b1", "flight_b2", "flight_b3"]);
  });

  it("keeps the current in-memory state when backend fails", async () => {
    mockLoadPersistedState.mockRejectedValue(new Error("Backend unavailable"));

    const store = await getStore();
    await store.getState().hydrateFromBackend();

    const { flights } = store.getState();
    expect(flights).toHaveLength(0);
  });

  it("saves to backend via saveFlightsSlice when addFlight is called", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState([]));

    const store = await getStore();

    // Clear any calls from initialization
    mockSaveFlightsSlice.mockClear();
    mockSaveUiSlice.mockClear();

    store.getState().addFlight({
      title: "New Flight",
      objective: "Test objective",
      priority: "high",
      projectPath: "/tmp/test",
    });

    // saveState calls syncFlightsToBackend which calls saveFlightsSlice
    // Give the async void call a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSaveFlightsSlice).toHaveBeenCalled();
  });

  it("hydrateFromBackend accepts a pre-fetched persisted state", async () => {
    const prefetchedFlight = makeFlight({ id: "flight_prefetched", title: "Prefetched" });
    const persisted = makePersistedState([prefetchedFlight]);

    const store = await getStore();
    await store.getState().hydrateFromBackend(persisted);

    const { flights } = store.getState();
    expect(flights).toHaveLength(1);
    expect(flights[0].id).toBe("flight_prefetched");
    // Should NOT have called loadPersistedState since we passed data directly
    expect(mockLoadPersistedState).not.toHaveBeenCalled();
  });
});

describe("storage utility migration pattern", () => {
  const TEST_KEY = "packetcode:test-migration";

  beforeEach(() => {
    localStorage.clear();
  });

  it("loadFromStorage returns fallback when key is missing", async () => {
    // Dynamic import to get fresh module
    const { loadFromStorage } = await import("@/lib/storage");
    const result = loadFromStorage<{ items: string[] }>(TEST_KEY, { items: [] });
    expect(result).toEqual({ items: [] });
  });

  it("loadFromStorage returns parsed data when key exists", async () => {
    localStorage.setItem(TEST_KEY, JSON.stringify({ items: ["a", "b"] }));
    const { loadFromStorage } = await import("@/lib/storage");
    const result = loadFromStorage<{ items: string[] }>(TEST_KEY, { items: [] });
    expect(result).toEqual({ items: ["a", "b"] });
  });

  it("loadFromStorage returns fallback on corrupt JSON", async () => {
    localStorage.setItem(TEST_KEY, "{not valid json");
    const { loadFromStorage } = await import("@/lib/storage");
    const result = loadFromStorage<{ items: string[] }>(TEST_KEY, { items: [] });
    expect(result).toEqual({ items: [] });
  });

  it("saveToStorage writes JSON to localStorage", async () => {
    const { saveToStorage } = await import("@/lib/storage");
    saveToStorage(TEST_KEY, { items: ["x"] });
    const raw = localStorage.getItem(TEST_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ items: ["x"] });
  });

  it("removeFromStorage clears the key", async () => {
    localStorage.setItem(TEST_KEY, "data");
    const { removeFromStorage } = await import("@/lib/storage");
    removeFromStorage(TEST_KEY);
    expect(localStorage.getItem(TEST_KEY)).toBeNull();
  });

  it("generateId produces unique prefixed IDs", async () => {
    const { generateId } = await import("@/lib/storage");
    const id1 = generateId("test");
    const id2 = generateId("test");
    expect(id1).toMatch(/^test_/);
    expect(id2).toMatch(/^test_/);
    expect(id1).not.toBe(id2);
  });
});
