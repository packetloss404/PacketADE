import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@/stores/issueStore";
import type { Flight } from "@/types/flight";

const mocks = vi.hoisted(() => ({
  appState: {
    setActiveView: vi.fn(),
  },
  deployState: {
    configs: [],
    runs: [],
    fetchConfigs: vi.fn(),
    startRun: vi.fn(),
  },
  flightState: {
    removeIssueFromFlight: vi.fn(),
  },
  issueState: {
    issues: [] as Issue[],
    assignToFlight: vi.fn(),
    moveIssue: vi.fn(),
  },
}));

vi.mock("@/stores/appStore", () => ({
  useAppStore: vi.fn((selector?: (s: typeof mocks.appState) => unknown) =>
    selector ? selector(mocks.appState) : mocks.appState,
  ),
}));

vi.mock("@/stores/deployStore", () => ({
  useDeployStore: vi.fn(() => mocks.deployState),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.flightState) => unknown) =>
      selector ? selector(mocks.flightState) : mocks.flightState,
    ),
    { getState: vi.fn(() => mocks.flightState) },
  ),
}));

vi.mock("@/stores/issueStore", () => ({
  useIssueStore: vi.fn((selector?: (s: typeof mocks.issueState) => unknown) =>
    selector ? selector(mocks.issueState) : mocks.issueState,
  ),
}));

vi.mock("@/components/flights/FlightHeaderTile", () => ({
  FlightHeaderTile: () => <div data-testid="flight-header" />,
}));

vi.mock("@/components/flights/FlightStatStrip", () => ({
  FlightStatStrip: () => <div data-testid="flight-stats" />,
}));

vi.mock("@/components/flights/MilestonesPanel", () => ({
  MilestonesPanel: () => <div data-testid="milestones-panel" />,
}));

vi.mock("@/components/flights/AsyncFlightGrid", () => ({
  AsyncFlightGrid: () => <div data-testid="async-flight-grid" />,
}));

vi.mock("@/components/session/TerminalPane", () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

import { FlightDetail } from "@/components/flights/FlightDetail";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Unlink Flight",
    objective: "Keep issue links consistent",
    status: "draft",
    priority: "medium",
    projectPath: "/test",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: ["issue-1"],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    ticketId: "ISS-1",
    title: "Linked issue",
    description: "Regression fixture",
    status: "todo",
    priority: "medium",
    labels: [],
    epic: null,
    flightId: "flight-1",
    acceptanceCriteria: [],
    blockedBy: [],
    blocks: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("FlightDetail linked issues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueState.issues = [makeIssue()];
  });

  it("unlinks issues from both issue and flight stores", () => {
    render(<FlightDetail flight={makeFlight()} />);

    fireEvent.click(screen.getByTitle("Unlink from flight"));

    expect(mocks.issueState.assignToFlight).toHaveBeenCalledWith("issue-1", null);
    expect(mocks.flightState.removeIssueFromFlight).toHaveBeenCalledWith("flight-1", "issue-1");
  });
});
