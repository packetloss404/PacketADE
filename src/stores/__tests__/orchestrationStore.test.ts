import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
import {
  MAX_CONSECUTIVE_TICK_FAILURES,
  useOrchestrationSchedulerStore,
} from "@/stores/orchestrationSchedulerStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { getOrchestrationState, orchestrationTick, saveSettingsSlice } from "@/lib/tauri";

function stubGrantedNotifications() {
  const notificationSpy = vi.fn();

  class TestNotification {
    static permission: NotificationPermission = "granted";

    constructor(title: string, options?: NotificationOptions) {
      notificationSpy(title, options);
    }
  }

  vi.stubGlobal("Notification", TestNotification);
  return notificationSpy;
}

describe("orchestrationStateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(orchestrationTick).mockResolvedValue([]);
    useOrchestrationSchedulerStore.getState().stopLoop();
    useOrchestrationStateStore.setState({
      runningTasks: new Map(),
      maxParallelSessions: 3,
      activeFlightIds: new Set(),
      milestoneGating: true,
      pausedAtMilestone: new Map(),
    });
    useOrchestrationSchedulerStore.setState({
      loopRunning: false,
      lastError: null,
    });
    useNotificationStore.setState({
      enabled: true,
      onlyWhenUnfocused: false,
      onApprovalNeeded: true,
      onSessionComplete: true,
      onSessionError: true,
    });
  });

  afterEach(() => {
    useOrchestrationSchedulerStore.getState().stopLoop();
    vi.unstubAllGlobals();
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
    const result = useOrchestrationStateStore.getState().getRunningTasksForFlight("unknown");
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

  it("logs failures and pauses the scheduler after repeated orchestrationTick failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notificationSpy = stubGrantedNotifications();
    const failure = new Error("backend tick failed");
    vi.mocked(orchestrationTick).mockRejectedValue(failure);
    useOrchestrationSchedulerStore.setState({ loopRunning: true });

    try {
      for (let i = 0; i < MAX_CONSECUTIVE_TICK_FAILURES; i += 1) {
        await useOrchestrationSchedulerStore.getState().tick();
      }

      expect(orchestrationTick).toHaveBeenCalledTimes(MAX_CONSECUTIVE_TICK_FAILURES);
      expect(warnSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_TICK_FAILURES);
      expect(warnSpy).toHaveBeenLastCalledWith(
        `[orchestration.tick (consecutive failure #${MAX_CONSECUTIVE_TICK_FAILURES})] swallowed error:`,
        failure,
      );
      expect(useOrchestrationSchedulerStore.getState().loopRunning).toBe(false);
      expect(useOrchestrationSchedulerStore.getState().lastError).toContain(
        `${MAX_CONSECUTIVE_TICK_FAILURES} times in a row`,
      );
      expect(notificationSpy).toHaveBeenCalledTimes(1);
      expect(notificationSpy).toHaveBeenCalledWith(
        "Orchestration paused",
        expect.objectContaining({
          body: expect.stringContaining(`${MAX_CONSECUTIVE_TICK_FAILURES} times in a row`),
          tag: "orchestration-scheduler-stalled",
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("resets the orchestrationTick failure streak after a healthy tick", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notificationSpy = stubGrantedNotifications();
    const initialFailure = new Error("initial failure");
    const postHealthyFailure = new Error("post-healthy failure");
    vi.mocked(orchestrationTick)
      .mockRejectedValueOnce(initialFailure)
      .mockRejectedValueOnce(initialFailure)
      .mockResolvedValueOnce([])
      .mockRejectedValue(postHealthyFailure);
    useOrchestrationSchedulerStore.setState({ loopRunning: true });

    try {
      await useOrchestrationSchedulerStore.getState().tick();
      await useOrchestrationSchedulerStore.getState().tick();
      await useOrchestrationSchedulerStore.getState().tick();

      for (let i = 0; i < MAX_CONSECUTIVE_TICK_FAILURES - 1; i += 1) {
        await useOrchestrationSchedulerStore.getState().tick();
      }

      expect(notificationSpy).not.toHaveBeenCalled();
      expect(useOrchestrationSchedulerStore.getState().loopRunning).toBe(true);

      await useOrchestrationSchedulerStore.getState().tick();

      expect(notificationSpy).toHaveBeenCalledTimes(1);
      expect(useOrchestrationSchedulerStore.getState().loopRunning).toBe(false);
      expect(useOrchestrationSchedulerStore.getState().lastError).toContain(
        `${MAX_CONSECUTIVE_TICK_FAILURES} times in a row`,
      );
      expect(warnSpy).toHaveBeenLastCalledWith(
        `[orchestration.tick (consecutive failure #${MAX_CONSECUTIVE_TICK_FAILURES})] swallowed error:`,
        postHealthyFailure,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces stalled scheduler state even when desktop notifications are unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("Notification", { permission: "denied" });
    const failure = new Error("backend tick failed");
    vi.mocked(orchestrationTick).mockRejectedValue(failure);
    useOrchestrationSchedulerStore.setState({ loopRunning: true, lastError: null });

    try {
      for (let i = 0; i < MAX_CONSECUTIVE_TICK_FAILURES; i += 1) {
        await useOrchestrationSchedulerStore.getState().tick();
      }

      expect(useOrchestrationSchedulerStore.getState().loopRunning).toBe(false);
      expect(useOrchestrationSchedulerStore.getState().lastError).toContain(
        "Flight scheduler backend failed",
      );

      vi.mocked(orchestrationTick).mockResolvedValueOnce([]);
      useOrchestrationSchedulerStore.getState().startLoop();
      expect(useOrchestrationSchedulerStore.getState().lastError).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
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
