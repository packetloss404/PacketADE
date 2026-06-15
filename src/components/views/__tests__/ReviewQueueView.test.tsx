import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Flight } from "@/types/flight";

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: vi.fn(),
}));
vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: {
    getState: vi.fn().mockReturnValue({ onTaskApprovalResolved: vi.fn() }),
  },
}));

import { useFlightStore } from "@/stores/flightStore";
import { ReviewQueueView } from "@/components/views/ReviewQueueView";

const mockUseFlightStore = vi.mocked(useFlightStore);

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Test Flight",
    objective: "Test objective",
    status: "active",
    priority: "medium",
    projectPath: "/test",
    workspaceId: null,
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

describe("ReviewQueueView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "No pending approvals" when no tasks need approval', () => {
    // Flight with no approval_needed tasks
    const flight = makeFlight({
      milestones: [
        {
          id: "ms-1",
          flightId: "flight-1",
          title: "Milestone 1",
          description: "",
          order: 0,
          status: "active",
          tasks: [
            {
              id: "task-1",
              milestoneId: "ms-1",
              flightId: "flight-1",
              title: "Done Task",
              description: "",
              order: 0,
              status: "done",
              type: "implementation",
              agentConfigId: "claude",
              dependsOn: [],
              sessionId: null,
              createdAt: Date.now(),
              cost: 0,
              tokens: 0,
            },
          ],
          validationCriteria: [],
        },
      ],
    });

    mockUseFlightStore.mockImplementation((selector: unknown) => {
      const state = { flights: [flight] };
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state;
    });

    render(<ReviewQueueView />);
    expect(screen.getByText("No pending approvals")).toBeInTheDocument();
  });

  it("shows approval count badge when tasks need approval", () => {
    const flight = makeFlight({
      milestones: [
        {
          id: "ms-1",
          flightId: "flight-1",
          title: "Milestone 1",
          description: "",
          order: 0,
          status: "active",
          tasks: [
            {
              id: "task-1",
              milestoneId: "ms-1",
              flightId: "flight-1",
              title: "Approval Task 1",
              description: "",
              order: 0,
              status: "approval_needed",
              type: "implementation",
              agentConfigId: "claude",
              dependsOn: [],
              sessionId: null,
              createdAt: Date.now(),
              startedAt: Date.now() - 60000,
              cost: 0,
              tokens: 0,
            },
            {
              id: "task-2",
              milestoneId: "ms-1",
              flightId: "flight-1",
              title: "Approval Task 2",
              description: "",
              order: 1,
              status: "approval_needed",
              type: "review",
              agentConfigId: "codex",
              dependsOn: [],
              sessionId: null,
              createdAt: Date.now(),
              startedAt: Date.now() - 120000,
              cost: 0,
              tokens: 0,
            },
          ],
          validationCriteria: [],
        },
      ],
    });

    mockUseFlightStore.mockImplementation((selector: unknown) => {
      const state = { flights: [flight] };
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state;
    });

    render(<ReviewQueueView />);
    // Badge should show "2"
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders flight title and task title for approval items", () => {
    const flight = makeFlight({
      title: "Auth Feature Flight",
      milestones: [
        {
          id: "ms-1",
          flightId: "flight-1",
          title: "Login Milestone",
          description: "",
          order: 0,
          status: "active",
          tasks: [
            {
              id: "task-1",
              milestoneId: "ms-1",
              flightId: "flight-1",
              title: "Implement OAuth handler",
              description: "",
              order: 0,
              status: "approval_needed",
              type: "implementation",
              agentConfigId: "claude",
              dependsOn: [],
              sessionId: null,
              createdAt: Date.now(),
              startedAt: Date.now() - 30000,
              cost: 0,
              tokens: 0,
            },
          ],
          validationCriteria: [],
        },
      ],
    });

    mockUseFlightStore.mockImplementation((selector: unknown) => {
      const state = { flights: [flight] };
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state;
    });

    render(<ReviewQueueView />);
    expect(screen.getByText("Implement OAuth handler")).toBeInTheDocument();
    expect(screen.getByText("Auth Feature Flight")).toBeInTheDocument();
    expect(screen.getByText("Login Milestone")).toBeInTheDocument();
  });
});
