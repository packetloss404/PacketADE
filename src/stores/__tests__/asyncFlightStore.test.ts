import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptTargetSpec } from "@/lib/tauri";
import type { Attempt, Flight, Task } from "@/types/flight";

const mocks = vi.hoisted(() => ({
  launchFlightAsync: vi.fn(),
  assertCostGuardrailsAllowLaunch: vi.fn(),
  createApiConversation: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  launchFlightAsync: mocks.launchFlightAsync,
  cancelFlightAttempt: vi.fn().mockResolvedValue(undefined),
  cleanupAttemptWorktreeSsh: vi.fn().mockResolvedValue(undefined),
  markAttemptStatus: vi.fn().mockResolvedValue(undefined),
  gitPushBranch: vi.fn().mockResolvedValue(undefined),
  githubCreatePr: vi.fn().mockResolvedValue(JSON.stringify({ number: 1 })),
  setAttemptDraftPr: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/stores/costGuardrailStore", () => ({
  assertCostGuardrailsAllowLaunch: mocks.assertCostGuardrailsAllowLaunch,
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: () => ({
      createApiConversation: mocks.createApiConversation,
    }),
  },
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: {
    getState: () => ({
      getServer: vi.fn(),
    }),
  },
}));

vi.mock("@/stores/githubStore", () => ({
  useGitHubStore: {
    getState: () => ({
      config: { selectedRepo: null },
    }),
  },
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: () => ({
      composeMemoryBrief: vi.fn().mockReturnValue({ text: "" }),
    }),
  },
}));

vi.mock("@/stores/issueStore", () => ({
  useIssueStore: {
    getState: () => ({
      issues: [],
      assignToFlight: vi.fn(),
    }),
  },
}));

vi.mock("@/stores/routingStore", () => ({
  useRoutingStore: {
    getState: () => ({
      resolveForTask: vi.fn().mockReturnValue({ agentConfigId: "claude-code" }),
    }),
  },
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspaces: [],
      createWorkspace: vi.fn().mockReturnValue("workspace-1"),
    }),
  },
}));

import { findAsyncLaunchPathCollisions, useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";

function localTarget(basePath: string, baseBranch = "main"): AttemptTargetSpec {
  return {
    kind: "local",
    basePath,
    baseBranch,
    agentConfigId: "api-claude",
    provider: "claude",
    model: "claude-sonnet-4-6",
  };
}

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Mission",
    objective: "Do work",
    status: "active",
    priority: "medium",
    projectPath: "D:/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    attempts: [],
    ...overrides,
  };
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "att-running",
    flightId: "flight-1",
    target: {
      kind: "local",
      basePath: "D:\\Repo",
      worktreePath: "D:\\Repo\\.git\\packetade-worktrees\\att-running",
    },
    agentConfigId: "api-claude",
    model: "claude-sonnet-4-6",
    provider: "claude",
    branch: "packetade/att-running",
    baseBranch: "main",
    sessionId: "att-running",
    status: "running",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    milestoneId: "ms-1",
    flightId: "flight-1",
    title: "Task 1",
    description: "",
    order: 0,
    status: "queued",
    type: "implementation",
    agentConfigId: "api-claude",
    dependsOn: [],
    sessionId: null,
    createdAt: 1,
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

describe("asyncFlightStore collision gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.launchFlightAsync.mockResolvedValue([]);
    mocks.assertCostGuardrailsAllowLaunch.mockResolvedValue(undefined);
    mocks.createApiConversation.mockResolvedValue(undefined);
    useFlightStore.setState({ flights: [], activeFlightId: null });
  });

  it("detects duplicate selected targets that claim the same root", () => {
    const collisions = findAsyncLaunchPathCollisions(
      null,
      [localTarget("D:\\Repo"), localTarget("d:/repo/src")],
      [],
    );

    expect(collisions).toHaveLength(1);
    expect(collisions[0].kind).toBe("duplicate_target");
  });

  it("blocks launch when an active attempt already claims the same path", async () => {
    useFlightStore.setState({
      flights: [flight({ id: "existing-flight", attempts: [attempt()] })],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("new-flight", "Do it", [localTarget("d:/repo")]),
    ).rejects.toThrow(/already running/);

    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
  });

  it("does not block completed attempts on the same path", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          id: "existing-flight",
          attempts: [attempt({ status: "completed", completedAt: 2 })],
        }),
      ],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("new-flight", "Do it", [localTarget("d:/repo")]),
    ).resolves.toEqual([]);

    expect(mocks.launchFlightAsync).toHaveBeenCalledOnce();
  });

  it("blocks launch when active mission tasks already have overlapping owned paths", async () => {
    useFlightStore.setState({
      flights: [
        flight({
          milestones: [
            {
              id: "ms-1",
              flightId: "flight-1",
              title: "Milestone",
              description: "",
              order: 0,
              status: "active",
              validationCriteria: [],
              tasks: [
                task({ id: "task-1", title: "Frontend", ownedPaths: ["src/features"] }),
                task({
                  id: "task-2",
                  title: "Button",
                  status: "running",
                  ownedPaths: ["SRC\\features\\button.tsx"],
                }),
              ],
            },
          ],
        }),
      ],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore.getState().launchAsync("flight-1", "Do it", [localTarget("d:/repo")]),
    ).rejects.toThrow(/both claim/);

    expect(mocks.launchFlightAsync).not.toHaveBeenCalled();
  });

  it("allows an explicit collision override for serialized handoff flows", async () => {
    useFlightStore.setState({
      flights: [flight({ id: "existing-flight", attempts: [attempt()] })],
      activeFlightId: null,
    });

    await expect(
      useAsyncFlightStore
        .getState()
        .launchAsync("new-flight", "Do it", [localTarget("d:/repo")], {
          allowPathCollisions: true,
        }),
    ).resolves.toEqual([]);

    expect(mocks.launchFlightAsync).toHaveBeenCalledOnce();
  });
});
