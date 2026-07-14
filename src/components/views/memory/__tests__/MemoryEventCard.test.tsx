/**
 * MemoryEventCard provenance deep-links.
 *
 * Provenance ids on a timeline card are clickable and route to the surface that
 * produced the event: flightId → Flights (setActiveFlight + flights view),
 * sessionId → focusConversationDeepLink, taskId → the owning flight. A target
 * that no longer resolves in the store renders as inert text (never a dead
 * link).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flight, Task } from "@/types/flight";
import type { MemoryEvent } from "@/types/memory";

// flightStore + appStore are REAL (the navigation is the subject); only their
// Tauri persistence boundary is stubbed.
vi.mock("@/lib/tauri", () => ({
  saveFlightsSlice: vi.fn(),
  saveUiSlice: vi.fn(),
  loadPersistedState: vi.fn(),
}));

// sessionGlue reaches into other stores; assert the deep-link call directly.
const focusConversationDeepLink = vi.fn();
vi.mock("@/stores/sessionGlue", () => ({
  focusConversationDeepLink: (id: string) => focusConversationDeepLink(id),
}));

import { MemoryEventCard } from "@/components/views/memory/MemoryEventCard";
import { useFlightStore } from "@/stores/flightStore";
import { useAppStore } from "@/stores/appStore";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    milestoneId: "ms-1",
    flightId: "flight-1",
    title: "Wire the cost alerts",
    description: "",
    order: 0,
    status: "done",
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

function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Cost guardrails",
    objective: "",
    status: "review",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: "ws-1",
    milestones: [
      {
        id: "ms-1",
        flightId: "flight-1",
        title: "Milestone",
        description: "",
        order: 0,
        status: "done",
        tasks: [task()],
        validationCriteria: [],
      },
    ],
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

const flightEvent: Extract<MemoryEvent, { type: "flight_completed" }> = {
  id: "evt-flight",
  timestamp: 1,
  projectPath: "/repo",
  type: "flight_completed",
  payload: {
    flightId: "flight-1",
    flightTitle: "Cost guardrails",
    summary: "Landed the guardrails.",
    whatWorked: [],
    whatFailed: [],
    lessonsLearned: [],
    suggestedImprovements: [],
    tags: [],
  },
};

const taskEvent: Extract<MemoryEvent, { type: "task_completed" }> = {
  id: "evt-task",
  timestamp: 1,
  projectPath: "/repo",
  type: "task_completed",
  payload: {
    taskId: "task-1",
    taskTitle: "Wire the cost alerts",
    flightId: "flight-1",
    flightTitle: "Cost guardrails",
    milestoneId: "ms-1",
    success: true,
    exitCode: 0,
    summary: "Done.",
    filesChanged: [],
    errors: [],
    durationMs: 1000,
  },
};

const sessionEvent: Extract<MemoryEvent, { type: "session_completed" }> = {
  id: "evt-session",
  timestamp: 1,
  projectPath: "/repo",
  type: "session_completed",
  payload: {
    sessionId: "conv-1",
    agentId: "api-claude",
    durationMs: 1000,
    status: "done",
    summary: null,
    filesModified: [],
    keyDecisions: [],
  },
};

beforeEach(() => {
  focusConversationDeepLink.mockClear();
  useFlightStore.setState({ flights: [], activeFlightId: null });
  useAppStore.setState({ activeView: "memory" });
});

describe("MemoryEventCard provenance deep-links", () => {
  it("opens the flight from a flight_completed card when the flight exists", () => {
    useFlightStore.setState({ flights: [flight()] });

    render(<MemoryEventCard event={flightEvent} onDelete={() => {}} />);
    fireEvent.click(screen.getByTitle("Open flight"));

    expect(useFlightStore.getState().activeFlightId).toBe("flight-1");
    expect(useAppStore.getState().activeView).toBe("flights");
  });

  it("renders the flight title inert when the flight no longer exists", () => {
    render(<MemoryEventCard event={flightEvent} onDelete={() => {}} />);

    expect(screen.queryByTitle("Open flight")).toBeNull();
    expect(screen.getByText("Cost guardrails")).toBeInTheDocument();
  });

  it("opens the owning flight for a task_completed card via its taskId", () => {
    useFlightStore.setState({ flights: [flight()] });

    render(<MemoryEventCard event={taskEvent} onDelete={() => {}} />);
    fireEvent.click(screen.getByTitle("Open flight for this task"));

    expect(useFlightStore.getState().activeFlightId).toBe("flight-1");
    expect(useAppStore.getState().activeView).toBe("flights");
  });

  it("renders the task title inert when no flight owns the task", () => {
    // A flight in the store, but without the task — the taskId does not resolve.
    useFlightStore.setState({
      flights: [flight({ milestones: [] })],
    });

    render(<MemoryEventCard event={taskEvent} onDelete={() => {}} />);

    expect(
      screen.queryByTitle("Open flight for this task"),
    ).toBeNull();
    expect(screen.getByText("Wire the cost alerts")).toBeInTheDocument();
  });

  it("deep-links to the conversation from a session_completed card", () => {
    render(<MemoryEventCard event={sessionEvent} onDelete={() => {}} />);
    fireEvent.click(screen.getByTitle("Open conversation"));

    expect(focusConversationDeepLink).toHaveBeenCalledWith("conv-1");
  });
});
