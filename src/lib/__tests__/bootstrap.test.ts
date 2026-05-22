import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSaveUiSlice = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAppState = vi.hoisted(() => ({
  activeView: "missions",
  theme: "dark" as const,
}));

vi.mock("@/lib/tauri", () => ({
  getAppKnownHostsPath: vi.fn(),
  getCwd: vi.fn(),
  loadPersistedState: vi.fn(),
  saveUiSlice: mockSaveUiSlice,
}));

vi.mock("@/lib/logSwallowed", () => ({
  logSwallowed: () => vi.fn(),
}));

vi.mock("@/lib/sshTargetMigration", () => ({
  migrateSshTargetsToServers: vi.fn(),
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: () => mockAppState,
  },
}));

vi.mock("@/stores/workspaceStore", () => ({ useWorkspaceStore: { getState: vi.fn() } }));
vi.mock("@/stores/agentStore", () => ({ useAgentStore: { getState: vi.fn() } }));
vi.mock("@/stores/flightStore", () => ({ useFlightStore: { getState: vi.fn() } }));
vi.mock("@/stores/layoutStore", () => ({ useLayoutStore: { getState: vi.fn() } }));
vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: { getState: vi.fn() },
}));
vi.mock("@/stores/memoryStore", () => ({ useMemoryStore: { getState: vi.fn() } }));
vi.mock("@/stores/serverStore", () => ({ useServerStore: { getState: vi.fn() } }));

import { persistUiState } from "@/lib/bootstrap";

describe("persistUiState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSaveUiSlice.mockClear();
    mockAppState.activeView = "missions";
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
      selectedView: "missions",
      theme: "dark",
    });
  });
});
