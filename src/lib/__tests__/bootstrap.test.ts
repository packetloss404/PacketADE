import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSaveUiSlice = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockLoadPersistedState = vi.hoisted(() => vi.fn());
const mockGetCwd = vi.hoisted(() => vi.fn());
const mockGetAppKnownHostsPath = vi.hoisted(() => vi.fn());
const mockMigrateSshTargetsToServers = vi.hoisted(() => vi.fn());
const mockWorkspaceHydrate = vi.hoisted(() => vi.fn());
const mockMemoryHydrate = vi.hoisted(() => vi.fn());
const mockServerHydrate = vi.hoisted(() => vi.fn());
const mockSetKnownHostsPath = vi.hoisted(() => vi.fn());
const mockIssueHydrate = vi.hoisted(() => vi.fn());
const mockFlightHydrate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAgentHydrate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDetectInstalled = vi.hoisted(() => vi.fn());
const mockLayoutSetProjectPath = vi.hoisted(() => vi.fn());
const mockOrchestrationSettingsHydrate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSetInitialized = vi.hoisted(() => vi.fn());
const mockSetTheme = vi.hoisted(() => vi.fn());
const mockSetActiveView = vi.hoisted(() => vi.fn());
const mockStartBoundedAutonomyRuntime = vi.hoisted(() => vi.fn());
const mockHydrateConversations = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockIsModuleEnabled = vi.hoisted(() => vi.fn(() => true));
const mockSyncAuxRouting = vi.hoisted(() => vi.fn());
const mockListen = vi.hoisted(() => vi.fn().mockResolvedValue(vi.fn()));
const mockAppState = vi.hoisted(() => ({
  activeView: "flights",
  theme: "dark" as const,
  setInitialized: mockSetInitialized,
  setTheme: mockSetTheme,
  setActiveView: mockSetActiveView,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@/lib/tauri", () => ({
  getAppKnownHostsPath: mockGetAppKnownHostsPath,
  getCwd: mockGetCwd,
  loadPersistedState: mockLoadPersistedState,
  saveUiSlice: mockSaveUiSlice,
}));

vi.mock("@/lib/logSwallowed", () => ({
  logSwallowed: () => vi.fn(),
}));

vi.mock("@/lib/sshTargetMigration", () => ({
  migrateSshTargetsToServers: mockMigrateSshTargetsToServers,
}));

// Only the store singleton is faked — `resolveStartupView` / `normalizeView`
// stay real so the startup-view tests exercise the actual route rules.
vi.mock("@/stores/appStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/appStore")>()),
  useAppStore: {
    getState: () => mockAppState,
  },
}));

vi.mock("@/stores/moduleStore", () => ({
  useModuleStore: { getState: () => ({ isEnabled: mockIsModuleEnabled }) },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ hydrateFromBackend: mockWorkspaceHydrate }) },
}));
vi.mock("@/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      hydrateFromBackend: mockAgentHydrate,
      detectInstalled: mockDetectInstalled,
    }),
  },
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: { getState: () => ({ hydrateFromBackend: mockFlightHydrate }) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ setProjectPath: mockLayoutSetProjectPath }) },
}));
vi.mock("@/stores/orchestrationSettingsStore", () => ({
  useOrchestrationSettingsStore: {
    getState: () => ({ hydrateFromBackend: mockOrchestrationSettingsHydrate }),
  },
}));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: () => ({ hydrateFromBackend: mockMemoryHydrate }) },
}));
vi.mock("@/stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({
      hydrateFromBackend: mockServerHydrate,
      setKnownHostsPath: mockSetKnownHostsPath,
    }),
  },
}));
vi.mock("@/stores/issueStore", () => ({
  useIssueStore: { getState: () => ({ hydrateFromBackend: mockIssueHydrate }) },
}));
vi.mock("@/stores/boundedAutonomyRuntime", () => ({
  startBoundedAutonomyRuntime: mockStartBoundedAutonomyRuntime,
}));
vi.mock("@/stores/agentConversationPersistence", () => ({
  hydrateConversations: mockHydrateConversations,
}));
vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: { getState: () => ({ syncAuxRouting: mockSyncAuxRouting }) },
}));

import { initializeApp, persistUiState } from "@/lib/bootstrap";

function makePersistedState(selectedView: string | null = null) {
  return {
    version: 1,
    flights: [],
    agents: [],
    issues: [{ id: "issue-1", ticketId: "PKT-001" }],
    settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "/repo" },
    ui: { theme: "dark", selectedView, selectedFlightId: null },
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
  };
}

describe("persistUiState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSaveUiSlice.mockClear();
    mockAppState.activeView = "flights";
    mockAppState.theme = "dark";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not clear the selected flight when persisting view and theme", async () => {
    persistUiState();

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(mockSaveUiSlice).toHaveBeenCalledWith({
      selectedView: "flights",
      theme: "dark",
    });
  });
});

describe("initializeApp", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockLoadPersistedState.mockResolvedValue(makePersistedState());
    mockGetCwd.mockResolvedValue("/cwd");
    mockGetAppKnownHostsPath.mockResolvedValue("known_hosts");
  });

  it("waits for SSH target migration before marking the app initialized", async () => {
    let resolveMigration!: (value: { migrated: number; skipped: number }) => void;
    mockMigrateSshTargetsToServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMigration = resolve;
        }),
    );

    const initialized = initializeApp();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockIssueHydrate).toHaveBeenCalledWith([{ id: "issue-1", ticketId: "PKT-001" }]);
    expect(mockSetInitialized).not.toHaveBeenCalled();

    resolveMigration({ migrated: 0, skipped: 0 });
    await initialized;

    expect(mockSetInitialized).toHaveBeenCalledWith(true);
    expect(mockFlightHydrate).toHaveBeenCalledWith(
      expect.objectContaining({ issues: [{ id: "issue-1", ticketId: "PKT-001" }] }),
    );
    expect(mockOrchestrationSettingsHydrate).toHaveBeenCalledWith(
      expect.objectContaining({ issues: [{ id: "issue-1", ticketId: "PKT-001" }] }),
    );
  });

  it("waits for conversation-file hydration before publishing initialized", async () => {
    let resolveConversations!: () => void;
    mockHydrateConversations.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConversations = resolve;
        }),
    );

    const initialized = initializeApp();
    await vi.waitFor(() => expect(mockWorkspaceHydrate).toHaveBeenCalled());
    expect(mockSetInitialized).not.toHaveBeenCalled();

    resolveConversations();
    await initialized;

    expect(mockSetInitialized).toHaveBeenCalledWith(true);
  });

  /**
   * WI-1: spec import / Code Quality AI / the GitHub PR AI features resolve
   * their provider in Rust, against a mirror of the frontend routing settings.
   * If boot never pushes that mirror, the settings card silently configures
   * nothing again — which is the exact defect this change set out to fix.
   */
  it("mirrors the auxiliary AI routing settings into the backend", async () => {
    await initializeApp();

    expect(mockSyncAuxRouting).toHaveBeenCalled();
  });

  it("restores the persisted view instead of forcing Welcome", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState("flights"));

    await initializeApp();

    expect(mockSetActiveView).toHaveBeenCalledWith("flights");
    expect(mockSetActiveView).toHaveBeenCalledTimes(1);
  });

  it("lands on Welcome when nothing was ever persisted", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState(null));

    await initializeApp();

    expect(mockSetActiveView).toHaveBeenCalledWith("welcome");
  });

  it("falls back to Welcome for a persisted view the registry no longer has", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState("dashboard"));

    await initializeApp();

    expect(mockSetActiveView).toHaveBeenCalledWith("welcome");
  });

  it("falls back to Welcome when the persisted view's module is disabled", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState("mod:dictation"));
    mockIsModuleEnabled.mockImplementationOnce(() => false);

    await initializeApp();

    expect(mockSetActiveView).toHaveBeenCalledWith("welcome");
  });

  it("restores the view after conversation hydration and before initialized", async () => {
    mockLoadPersistedState.mockResolvedValue(makePersistedState("agents"));
    const order: string[] = [];
    let resolveConversations!: () => void;
    mockHydrateConversations.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConversations = () => {
            order.push("conversations");
            resolve();
          };
        }),
    );
    mockSetActiveView.mockImplementationOnce(() => {
      order.push("view");
    });
    mockSetInitialized.mockImplementationOnce(() => {
      order.push("initialized");
    });

    const initialized = initializeApp();
    await vi.waitFor(() => expect(mockWorkspaceHydrate).toHaveBeenCalled());
    // The restore is gated on the conversation graph, not just on state.v1.json.
    expect(order).toEqual([]);

    resolveConversations();
    await initialized;

    expect(order).toEqual(["conversations", "view", "initialized"]);
  });
});
