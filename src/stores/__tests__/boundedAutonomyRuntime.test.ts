import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flight } from "@/types/flight";

const harness = vi.hoisted(() => {
  const flightListeners = new Set<() => void>();
  const agentListeners = new Set<() => void>();
  const value = {
    flights: [] as Flight[],
    conversations: [] as Array<Record<string, unknown>>,
    appendCoordinationEvent: vi.fn(),
    cancelAttempt: vi.fn().mockResolvedValue(undefined),
    reassignAttempt: vi.fn().mockResolvedValue(undefined),
    retryReviewGate: vi.fn().mockResolvedValue(undefined),
    sendReviewFindingsToBuilder: vi.fn().mockResolvedValue(undefined),
    setAttemptStatus: vi.fn().mockResolvedValue(undefined),
    launchReadyTasks: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    flightListeners,
    agentListeners,
  };
  return value;
});

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: () => ({
      flights: harness.flights,
      updateFlight: (id: string, updates: Partial<Flight>) => {
        harness.flights = harness.flights.map((flight) =>
          flight.id === id ? { ...flight, ...updates } : flight,
        );
        for (const listener of harness.flightListeners) listener();
      },
      appendCoordinationEvent: harness.appendCoordinationEvent,
    }),
    subscribe: (listener: () => void) => {
      harness.flightListeners.add(listener);
      return () => harness.flightListeners.delete(listener);
    },
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: () => ({
      conversations: harness.conversations,
      setPermissionMode: harness.setPermissionMode,
    }),
    subscribe: (listener: () => void) => {
      harness.agentListeners.add(listener);
      return () => harness.agentListeners.delete(listener);
    },
  },
}));

vi.mock("@/stores/asyncFlightStore", () => ({
  useAsyncFlightStore: {
    getState: () => ({
      cancelAttempt: harness.cancelAttempt,
      reassignAttempt: harness.reassignAttempt,
      retryReviewGate: harness.retryReviewGate,
      sendReviewFindingsToBuilder: harness.sendReviewFindingsToBuilder,
      setAttemptStatus: harness.setAttemptStatus,
      launchReadyTasks: harness.launchReadyTasks,
    }),
  },
}));

import {
  pauseFlightAutonomy,
  startBoundedAutonomyRuntime,
  startFlightAutonomy,
  stopFlightAutonomy,
} from "@/stores/boundedAutonomyRuntime";

function flight(status: "idle" | "running" | "paused" = "idle"): Flight {
  return {
    id: "flight-1",
    title: "Autonomy",
    objective: "Run",
    status: "active",
    priority: "medium",
    projectPath: "D:\\repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    executionMode: "cooperative",
    reviewGatePolicy: {
      enabled: true,
      reviewerAgentConfigId: "api-openai-codex",
      acceptanceCriteria: ["pass"],
    },
    autonomyMode: "yolo",
    autonomyPolicy: {
      schemaVersion: 1,
      autoRecovery: true,
      autoReviewRemediation: true,
      autoRunTaskGraph: true,
      toolPosture: "approval_gated",
      maxTotalCost: 25,
      maxDurationMinutes: 120,
      maxRetriesPerTask: 2,
      maxReviewRounds: 2,
      maxConcurrentAgents: 3,
      allowedRoots: ["D:\\repo"],
      allowedTargets: ["local"],
      allowDraftPrPublishing: false,
    },
    autonomyRuntime: {
      status,
      startedAt: status === "running" ? 1 : undefined,
      actionHistory: [],
    },
  };
}

describe("bounded autonomy supervision", () => {
  beforeEach(() => {
    harness.flights = [];
    harness.conversations = [];
    harness.flightListeners.clear();
    harness.agentListeners.clear();
    vi.clearAllMocks();
  });

  it("pauses a persisted running policy when the runtime starts after reload", () => {
    harness.flights = [flight("running")];
    const cleanup = startBoundedAutonomyRuntime();
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "paused",
      hardStopReason: expect.stringContaining("Resume explicitly"),
    });
    cleanup();
  });

  it("supports explicit start and pause without cancelling attempts", () => {
    harness.flights = [flight("idle")];
    startFlightAutonomy("flight-1");
    expect(harness.flights[0].autonomyRuntime?.status).toBe("running");
    pauseFlightAutonomy("flight-1");
    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "paused",
      hardStopReason: "Paused by the user.",
    });
    expect(harness.cancelAttempt).not.toHaveBeenCalled();
  });

  it("makes Stop terminal and cancels active attempts through the normal action", async () => {
    const value = flight("running");
    value.attempts = [
      {
        id: "attempt-1",
        flightId: value.id,
        target: { kind: "local", basePath: "D:\\repo", worktreePath: "D:\\attempt" },
        agentConfigId: "api-openai",
        model: "gpt-5",
        provider: "openai",
        branch: "packetade/attempt-1",
        baseBranch: "main",
        sessionId: "session-1",
        status: "running",
        cost: 0,
        tokens: 0,
      },
    ];
    harness.flights = [value];

    await stopFlightAutonomy("flight-1", true);

    expect(harness.flights[0].autonomyRuntime).toMatchObject({
      status: "stopped",
      hardStopReason: "Stopped by the user.",
    });
    expect(harness.cancelAttempt).toHaveBeenCalledWith("flight-1", "attempt-1");
    expect(() => startFlightAutonomy("flight-1")).toThrow("Choose YOLO again");
  });
});
