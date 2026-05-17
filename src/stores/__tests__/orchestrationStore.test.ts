import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the tauri module BEFORE importing the store
vi.mock("@/lib/tauri", () => ({
  launchFlightInBackend: vi.fn(),
  pauseFlightInBackend: vi.fn(),
  resumeFlightInBackend: vi.fn(),
  cancelFlightInBackend: vi.fn(),
  orchestrationTick: vi.fn().mockResolvedValue([]),
  getOrchestrationState: vi.fn().mockResolvedValue({
    runningTaskIds: [],
    runningTasks: [],
    activeFlightIds: [],
    pausedAtMilestone: [],
  }),
  recordTaskSpawn: vi.fn().mockResolvedValue(undefined),
  notifyTaskComplete: vi.fn(),
  notifyApprovalNeeded: vi.fn(),
  notifyApprovalResolved: vi.fn(),
  loadPersistedState: vi.fn().mockResolvedValue({
    version: 1,
    flights: [],
    agents: [],
    settings: {
      maxParallelSessions: 3,
      milestoneGating: true,
      projectPath: ".",
    },
    ui: {},
  }),
  saveSettingsSlice: vi.fn().mockResolvedValue(undefined),
  killPty: vi.fn().mockResolvedValue(undefined),
}));

// Mock flightStore
vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: vi.fn().mockReturnValue({
      flights: [],
      hydrateFromBackend: vi.fn(),
      updateTask: vi.fn(),
      updateMilestone: vi.fn(),
      updateFlight: vi.fn(),
      linkSessionToFlight: vi.fn(),
      unlinkSessionFromFlight: vi.fn(),
    }),
  },
}));

// Mock layoutStore
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn().mockReturnValue({
      addPane: vi.fn().mockReturnValue("pane-1"),
    }),
  },
}));

// Mock tabStore
vi.mock("@/stores/tabStore", () => ({
  useTabStore: {
    getState: vi.fn().mockReturnValue({
      tabs: [],
    }),
  },
}));

import { useOrchestrationStateStore } from "@/stores/orchestrationStateStore";
import { useOrchestrationSchedulerStore } from "@/stores/orchestrationSchedulerStore";
import { getOrchestrationState, orchestrationTick, saveSettingsSlice } from "@/lib/tauri";

describe("orchestrationStateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrchestrationStateStore.setState({
      runningTasks: new Map(),
      maxParallelSessions: 3,
      activeFlightIds: new Set(),
      milestoneGating: true,
      pausedAtMilestone: new Map(),
    });
    useOrchestrationSchedulerStore.setState({
      loopRunning: false,
    });
  });

  it("initial state has correct defaults", () => {
    const state = useOrchestrationStateStore.getState();
    expect(state.maxParallelSessions).toBe(3);
    expect(state.milestoneGating).toBe(true);
    expect(state.runningTasks).toBeInstanceOf(Map);
    expect(state.runningTasks.size).toBe(0);
    expect(state.activeFlightIds).toBeInstanceOf(Set);
    expect(state.activeFlightIds.size).toBe(0);
    expect(useOrchestrationSchedulerStore.getState().loopRunning).toBe(false);
  });

  it("setMaxParallelSessions updates state", () => {
    useOrchestrationStateStore.getState().setMaxParallelSessions(5);
    expect(useOrchestrationStateStore.getState().maxParallelSessions).toBe(5);
  });

  it("setMaxParallelSessions clamps unsafe values", async () => {
    useOrchestrationStateStore.getState().setMaxParallelSessions(50);
    expect(useOrchestrationStateStore.getState().maxParallelSessions).toBe(12);
    await Promise.resolve();
    await Promise.resolve();
    expect(saveSettingsSlice).toHaveBeenLastCalledWith({
      maxParallelSessions: 12,
      milestoneGating: true,
      projectPath: ".",
    });

    useOrchestrationStateStore.getState().setMaxParallelSessions(0);
    expect(useOrchestrationStateStore.getState().maxParallelSessions).toBe(1);
  });

  it("setMilestoneGating updates state", () => {
    useOrchestrationStateStore.getState().setMilestoneGating(false);
    expect(useOrchestrationStateStore.getState().milestoneGating).toBe(false);
  });

  it("isFlightActive returns false for unknown flight", () => {
    const result = useOrchestrationStateStore.getState().isFlightActive("unknown");
    expect(result).toBe(false);
  });

  it("getRunningTasksForFlight returns empty for unknown flight", () => {
    const result = useOrchestrationStateStore
      .getState()
      .getRunningTasksForFlight("unknown");
    expect(result).toEqual([]);
  });

  it("syncFromBackend updates state from snapshot", async () => {
    vi.mocked(getOrchestrationState).mockResolvedValueOnce({
      runningTaskIds: [],
      runningTasks: [],
      activeFlightIds: ["f1"],
      pausedAtMilestone: [["f1", "ms-2"]],
    } as never);

    await useOrchestrationStateStore.getState().syncFromBackend();

    const state = useOrchestrationStateStore.getState();
    expect(state.activeFlightIds.has("f1")).toBe(true);
    expect(state.activeFlightIds.size).toBe(1);
    expect(state.pausedAtMilestone.get("f1")).toBe("ms-2");
  });

  it("tick with no available slots does not call orchestrationTick", async () => {
    // Fill up all 3 slots
    const runningTasks = new Map([
      [
        "t1",
        {
          taskId: "t1",
          milestoneId: "ms-1",
          flightId: "f1",
          paneId: "p1",
          sessionId: "s1",
          agentConfigId: "agent-1",
          startedAt: Date.now(),
          command: "claude",
          args: [],
          prompt: "prompt",
          projectPath: "/test",
        },
      ],
      [
        "t2",
        {
          taskId: "t2",
          milestoneId: "ms-1",
          flightId: "f1",
          paneId: "p2",
          sessionId: "s2",
          agentConfigId: "agent-1",
          startedAt: Date.now(),
          command: "claude",
          args: [],
          prompt: "prompt",
          projectPath: "/test",
        },
      ],
      [
        "t3",
        {
          taskId: "t3",
          milestoneId: "ms-1",
          flightId: "f1",
          paneId: "p3",
          sessionId: "s3",
          agentConfigId: "agent-1",
          startedAt: Date.now(),
          command: "claude",
          args: [],
          prompt: "prompt",
          projectPath: "/test",
        },
      ],
    ]);
    useOrchestrationStateStore.setState({ runningTasks, maxParallelSessions: 3 });

    await useOrchestrationSchedulerStore.getState().tick();

    expect(orchestrationTick).not.toHaveBeenCalled();
  });

  it("hydrateFromBackend updates settings", async () => {
    await useOrchestrationStateStore.getState().hydrateFromBackend({
      version: 1,
      flights: [],
      agents: [],
      settings: {
        maxParallelSessions: 5,
        milestoneGating: false,
        projectPath: "/test",
      },
      ui: {},
    } as never);

    const state = useOrchestrationStateStore.getState();
    expect(state.maxParallelSessions).toBe(5);
    expect(state.milestoneGating).toBe(false);
  });

  it("hydrateFromBackend clamps unsafe max parallel settings", async () => {
    await useOrchestrationStateStore.getState().hydrateFromBackend({
      version: 1,
      flights: [],
      agents: [],
      settings: {
        maxParallelSessions: 50,
        milestoneGating: true,
        projectPath: "/test",
      },
      ui: {},
    } as never);

    expect(useOrchestrationStateStore.getState().maxParallelSessions).toBe(12);
  });
});
