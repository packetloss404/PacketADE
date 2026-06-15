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
const mockOrchestrationHydrate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSetInitialized = vi.hoisted(() => vi.fn());
const mockSetTheme = vi.hoisted(() => vi.fn());
const mockSetActiveView = vi.hoisted(() => vi.fn());
const mockAppState = vi.hoisted(() => ({
  activeView: "flights",
  theme: "dark" as const,
  setInitialized: mockSetInitialized,
  setTheme: mockSetTheme,
  setActiveView: mockSetActiveView,
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

vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => mockAppState,
  },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ hydrateFromBackend: mockWorkspaceHydrate }) },
}));
vi.mock("@/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({ hydrateFromBackend: mockAgentHydrate, detectInstalled: mockDetectInstalled }),
  },
}));
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: { getState: () => ({ hydrateFromBackend: mockFlightHydrate }) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ setProjectPath: mockLayoutSetProjectPath }) },
}));
vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: {
    getState: () => ({ hydrateFromBackend: mockOrchestrationHydrate }),
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

import { initializeApp, persistUiState } from "@/lib/bootstrap";

function makePersistedState() {
  return {
    version: 1,
    flights: [],
    agents: [],
    issues: [{ id: "issue-1", ticketId: "PKT-001" }],
    settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "/repo" },
    ui: { theme: "dark", selectedView: null, selectedFlightId: null },
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
  });
});
