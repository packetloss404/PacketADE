import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PersistedState } from "@/lib/tauri";

// Mock tauri functions
vi.mock("@/lib/tauri", () => ({
  loadPersistedState: vi.fn().mockResolvedValue({
    version: 1,
    flights: [],
    agents: [],
    settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
    ui: {},
  }),
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
}));

// Mock issueStore
vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: vi.fn().mockReturnValue({
      issues: [],
      assignToFlight: vi.fn(),
    }),
  },
}));

// Mock routingStore
vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: {
    getState: vi.fn().mockReturnValue({
      resolveForTask: vi.fn().mockReturnValue({
        agentConfigId: "claude-code",
        model: undefined,
      }),
    }),
  },
}));

import { useFlightStore } from "@/stores/flightStore";
import { useIssueStore } from "@/stores/issueStore";

function makePersistedState(
  flights: ReturnType<typeof useFlightStore.getState>["flights"],
): PersistedState {
  return {
    version: 1,
    flights,
    agents: [],
    issues: [],
    settings: { maxParallelSessions: 3, milestoneGating: true, projectPath: "." },
    ui: {},
    workspaces: [],
    memoryEvents: [],
    memoryPatterns: [],
    servers: [],
  };
}

function setMockIssues(issues: Array<{ id: string; flightId: string | null }>) {
  vi.mocked(useIssueStore.getState).mockReturnValue({
    issues,
    assignToFlight: vi.fn(),
  } as unknown as ReturnType<typeof useIssueStore.getState>);
}

describe("flightStore", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setMockIssues([]);
    useFlightStore.setState({
      flights: [],
      activeFlightId: null,
    });
  });

  it("addFlight creates a flight with correct defaults", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Test Flight",
      objective: "Build something",
      priority: "high",
      projectPath: "/tmp/project",
    });

    expect(flight.title).toBe("Test Flight");
    expect(flight.objective).toBe("Build something");
    expect(flight.priority).toBe("high");
    expect(flight.projectPath).toBe("/tmp/project");
    expect(flight.status).toBe("draft");
    expect(flight.milestones).toEqual([]);
    expect(flight.linkedSessionIds).toEqual([]);
    expect(flight.issueIds).toEqual([]);
    expect(flight.id).toMatch(/^flight_/);
    expect(flight.totalCost).toBe(0);
    expect(flight.totalTokens).toBe(0);

    const { flights } = useFlightStore.getState();
    expect(flights).toHaveLength(1);
    expect(flights[0].id).toBe(flight.id);
  });

  it("deleteFlight removes the flight", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "To Delete",
      objective: "Will be removed",
      priority: "low",
      projectPath: ".",
    });

    useFlightStore.getState().deleteFlight(flight.id);

    expect(useFlightStore.getState().flights).toHaveLength(0);
  });

  it("updateFlight updates fields", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Original",
      objective: "Obj",
      priority: "medium",
      projectPath: ".",
    });

    useFlightStore.getState().updateFlight(flight.id, { title: "New Title" });

    const updated = useFlightStore.getState().flights.find((f) => f.id === flight.id);
    expect(updated?.title).toBe("New Title");
    expect(updated?.objective).toBe("Obj"); // unchanged field preserved
  });

  it("setActiveFlight and getActiveFlight work together", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Active Flight",
      objective: "Test active",
      priority: "high",
      projectPath: ".",
    });

    expect(useFlightStore.getState().getActiveFlight()).toBeNull();

    useFlightStore.getState().setActiveFlight(flight.id);

    const active = useFlightStore.getState().getActiveFlight();
    expect(active).not.toBeNull();
    expect(active?.id).toBe(flight.id);
  });

  it("addMilestone adds to the correct flight", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "With Milestone",
      objective: "Milestone test",
      priority: "medium",
      projectPath: ".",
    });

    const msId = useFlightStore.getState().addMilestone(flight.id, {
      title: "MS-1",
      description: "First milestone",
      validationCriteria: ["tests pass"],
    });

    const updated = useFlightStore.getState().flights.find((f) => f.id === flight.id);
    expect(updated?.milestones).toHaveLength(1);
    expect(updated?.milestones[0].id).toBe(msId);
    expect(updated?.milestones[0].title).toBe("MS-1");
    expect(updated?.milestones[0].status).toBe("pending");
    expect(updated?.milestones[0].tasks).toEqual([]);
  });

  it("addTask adds to the correct milestone", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "With Task",
      objective: "Task test",
      priority: "medium",
      projectPath: ".",
    });

    const msId = useFlightStore.getState().addMilestone(flight.id, {
      title: "MS-1",
      description: "Milestone",
      validationCriteria: [],
    });

    const taskId = useFlightStore.getState().addTask(flight.id, msId, {
      title: "Implement feature",
      description: "Do the thing",
      type: "implementation",
      dependsOn: [],
    });

    const updated = useFlightStore.getState().flights.find((f) => f.id === flight.id);
    const milestone = updated?.milestones.find((m) => m.id === msId);
    expect(milestone?.tasks).toHaveLength(1);
    expect(milestone?.tasks[0].id).toBe(taskId);
    expect(milestone?.tasks[0].title).toBe("Implement feature");
    expect(milestone?.tasks[0].status).toBe("pending");
    expect(milestone?.tasks[0].type).toBe("implementation");
  });

  it("updateTask updates task fields", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Task Update",
      objective: "Update test",
      priority: "medium",
      projectPath: ".",
    });

    const msId = useFlightStore.getState().addMilestone(flight.id, {
      title: "MS-1",
      description: "Milestone",
      validationCriteria: [],
    });

    const taskId = useFlightStore.getState().addTask(flight.id, msId, {
      title: "Task",
      description: "Desc",
      type: "implementation",
      dependsOn: [],
    });

    useFlightStore.getState().updateTask(flight.id, msId, taskId, { status: "running" });

    const updated = useFlightStore.getState().flights.find((f) => f.id === flight.id);
    const task = updated?.milestones.find((m) => m.id === msId)?.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("running");
  });

  it("unlinkSessionFromFlight removes session ID", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Session Unlink",
      objective: "Unlink test",
      priority: "medium",
      projectPath: ".",
    });

    useFlightStore.getState().updateFlight(flight.id, { linkedSessionIds: ["sess-1"] });
    useFlightStore.getState().unlinkSessionFromFlight(flight.id, "sess-1");

    const updated = useFlightStore.getState().flights.find((f) => f.id === flight.id);
    expect(updated?.linkedSessionIds).toEqual([]);
  });

  it("computeFlightStatus returns draft for empty flight", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Empty Flight",
      objective: "No milestones",
      priority: "low",
      projectPath: ".",
    });

    const status = useFlightStore.getState().computeFlightStatus(flight.id);
    expect(status).toBe("draft");
  });

  it("reconciles flight issueIds from issue flight assignments", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Linked Flight",
      objective: "Link test",
      priority: "medium",
      projectPath: ".",
    });
    const otherFlight = useFlightStore.getState().addFlight({
      title: "Other Flight",
      objective: "Other link test",
      priority: "medium",
      projectPath: ".",
      issueIds: ["stale_issue"],
    });

    setMockIssues([
      { id: "issue_1", flightId: flight.id },
      { id: "issue_2", flightId: flight.id },
      { id: "issue_3", flightId: null },
      { id: "issue_4", flightId: "missing_flight" },
    ]);

    useFlightStore.getState().reconcileIssueLinks({ persist: false, touchUpdatedAt: false });

    const flights = useFlightStore.getState().flights;
    expect(flights.find((f) => f.id === flight.id)?.issueIds).toEqual(["issue_1", "issue_2"]);
    expect(flights.find((f) => f.id === otherFlight.id)?.issueIds).toEqual([]);
  });

  it("reconciles issue links after backend hydration", async () => {
    const backendFlight = {
      ...useFlightStore.getState().addFlight({
        title: "Backend Flight",
        objective: "Hydrate link test",
        priority: "medium",
        projectPath: ".",
      }),
      issueIds: [],
    };
    setMockIssues([{ id: "issue_hydrated", flightId: backendFlight.id }]);
    useFlightStore.setState({ flights: [], activeFlightId: null });

    await useFlightStore.getState().hydrateFromBackend(makePersistedState([backendFlight]));

    expect(useFlightStore.getState().flights[0].issueIds).toEqual(["issue_hydrated"]);
  });

  it("getFlightProgress counts done tasks", () => {
    const flight = useFlightStore.getState().addFlight({
      title: "Progress Flight",
      objective: "Progress test",
      priority: "medium",
      projectPath: ".",
    });

    const msId = useFlightStore.getState().addMilestone(flight.id, {
      title: "MS-1",
      description: "Milestone",
      validationCriteria: [],
    });

    const taskId1 = useFlightStore.getState().addTask(flight.id, msId, {
      title: "Task 1",
      description: "First",
      type: "implementation",
      dependsOn: [],
    });

    useFlightStore.getState().addTask(flight.id, msId, {
      title: "Task 2",
      description: "Second",
      type: "testing",
      dependsOn: [],
    });

    useFlightStore.getState().updateTask(flight.id, msId, taskId1, { status: "done" });

    const progress = useFlightStore.getState().getFlightProgress(flight.id);
    expect(progress).toEqual({ done: 1, total: 2 });
  });
});
