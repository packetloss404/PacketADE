/**
 * E8-TESTS — StatGrid cost-split coverage.
 *
 * Sibling E8-UI splits the single "Cost" cell on the flight detail pane
 * into "Planner" + "Exec" cells in `FlightsView.tsx`. Sibling E8-ACCUM
 * accumulates `flight.plannerCost` / `flight.plannerTokens` /
 * `flight.plannerProvider` on the Rust side and rolls them onto the Flight
 * DTO. This slice owns the FE regression tests for the new cells.
 *
 * Important: `StatGrid` is an internal helper inside `FlightsView.tsx` —
 * it is NOT exported. We considered three options:
 *
 *   1. Ask E8-UI to export it.
 *      Rejected: cross-slice coupling, and the helper is genuinely
 *      private to FlightsView. Exporting it just for tests is the
 *      tail wagging the dog.
 *
 *   2. Skip the tests with a comment.
 *      Rejected: the cost-split is the headline E8 user-visible change.
 *      We need coverage.
 *
 *   3. Mount `FlightsView` end-to-end with mocked stores and assert
 *      the StatGrid output through the rendered DOM.
 *      Chosen. This is the same approach `WorkspaceLaunchQuality.test.tsx`
 *      uses for the WorkspaceCreationModal helper, and it has the
 *      side benefit of catching regressions in how FlightDetailPane
 *      passes Flight props down to StatGrid.
 *
 * The trade-off: each test mounts the full FlightDetailPane subtree.
 * Several heavy children (PlannerApprovalGate, FlightSpecPane,
 * JournalTab, NewFlightModal, LaunchAsyncFlightModal) are mocked to no-op
 * stubs to keep the mount lightweight and the test free of unrelated
 * Tauri/listener wiring.
 *
 * Follow-up tracked in `backlog.md` (P3): if E8-UI or a later refactor
 * exports StatGrid, these tests can collapse to direct component
 * renders and the heavy mock surface can be retired.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Flight } from "@/types/flight";

// === Hoisted shared state ===
//
// vi.hoisted runs BEFORE the vi.mock factories below, so the factories can
// close over `mocks` and the test bodies can mutate it per-test.

const mocks = vi.hoisted(() => {
  return {
    flightState: {
      flights: [] as Flight[],
      activeFlightId: null as string | null,
      setActiveFlight: vi.fn(),
      addFlight: vi.fn(),
      updateFlight: vi.fn(),
      computeFlightStatus: vi.fn(() => "active"),
    },
    orchestrationState: {
      pauseFlight: vi.fn(),
      resumeFlight: vi.fn(),
    },
    schedulerState: {
      lastError: null as string | null,
      startLoop: vi.fn(),
    },
    plannerState: {
      startPlanner: vi.fn(),
      runtimes: new Map(),
    },
    workspaceState: {
      workspaces: [],
      activeWorkspaceId: null,
    },
    layoutState: {
      projectPath: "/test/path",
    },
    goalState: {
      getGoalsForFlight: vi.fn(() => []),
    },
  };
});

// === Store mocks ===

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.flightState) => unknown) =>
      selector ? selector(mocks.flightState) : mocks.flightState,
    ),
    { getState: vi.fn(() => mocks.flightState) },
  ),
}));

vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.orchestrationState) => unknown) =>
      selector ? selector(mocks.orchestrationState) : mocks.orchestrationState,
    ),
    { getState: vi.fn(() => mocks.orchestrationState) },
  ),
}));

vi.mock("@/stores/orchestrationSchedulerStore", () => ({
  useOrchestrationSchedulerStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.schedulerState) => unknown) =>
      selector ? selector(mocks.schedulerState) : mocks.schedulerState,
    ),
    { getState: vi.fn(() => mocks.schedulerState) },
  ),
}));

vi.mock("@/stores/flightPlannerStore", () => ({
  useFlightPlannerStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.plannerState) => unknown) =>
      selector ? selector(mocks.plannerState) : mocks.plannerState,
    ),
    { getState: vi.fn(() => mocks.plannerState) },
  ),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.workspaceState) => unknown) =>
      selector ? selector(mocks.workspaceState) : mocks.workspaceState,
    ),
    { getState: vi.fn(() => mocks.workspaceState) },
  ),
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.layoutState) => unknown) =>
      selector ? selector(mocks.layoutState) : mocks.layoutState,
    ),
    { getState: vi.fn(() => mocks.layoutState) },
  ),
}));

vi.mock("@/stores/goalStore", () => ({
  useGoalStore: Object.assign(
    vi.fn((selector?: (s: typeof mocks.goalState) => unknown) =>
      selector ? selector(mocks.goalState) : mocks.goalState,
    ),
    { getState: vi.fn(() => mocks.goalState) },
  ),
}));

// === Tauri / event mocks ===

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// === Heavy child component stubs ===
//
// These children pull in their own Tauri wiring, planner listeners, and
// modal portals — none of which affect the StatGrid contract. Replace
// with empty divs so the test mounts cleanly.

vi.mock("@/components/flights/FlightSpecPane", () => ({
  FlightSpecPane: () => <div data-testid="mock-spec-pane" />,
}));

vi.mock("@/components/flights/JournalTab", () => ({
  JournalTab: () => <div data-testid="mock-journal" />,
}));

vi.mock("@/components/flights/PlannerApprovalGate", () => ({
  PlannerApprovalGate: () => null,
}));

vi.mock("@/components/flights/NewFlightModal", () => ({
  NewFlightModal: () => null,
}));

vi.mock("@/components/flights/LaunchAsyncFlightModal", () => ({
  LaunchAsyncFlightModal: () => null,
}));

import { FlightsView } from "@/components/views/FlightsView";

// === Test helpers ===

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Cost Split Flight",
    objective: "test the cost split",
    status: "active",
    priority: "medium",
    projectPath: "/test",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalCost: 1.5,
    totalTokens: 50_000,
    ...overrides,
  };
}

// Find the stat card matching a label. Walks up from the label <span>
// to its parent cell so callers can scope further queries to one cell.
function statCell(label: string): HTMLElement {
  const labelNode = screen.getByText(label);
  const cell = labelNode.parentElement;
  if (!cell) throw new Error(`StatGrid cell for "${label}" not found`);
  return cell as HTMLElement;
}

function valueInCell(cell: HTMLElement): string {
  // Cell layout: <span label> <span value> [<span sub>]
  // The value lives in the second span.
  const spans = cell.querySelectorAll("span");
  if (spans.length < 2) throw new Error("cell has no value span");
  return spans[1]?.textContent ?? "";
}

function subInCell(cell: HTMLElement): string | null {
  const spans = cell.querySelectorAll("span");
  if (spans.length < 3) return null;
  return spans[2]?.textContent ?? null;
}

// === Tests ===

describe("StatGrid cost cells (E8 cost split)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flightState.flights = [];
    mocks.flightState.activeFlightId = null;
    mocks.flightState.computeFlightStatus = vi.fn(() => "active" as const);
    mocks.schedulerState.lastError = null;
    mocks.schedulerState.startLoop = vi.fn();
    mocks.goalState.getGoalsForFlight = vi.fn(() => []);
  });

  it("renders separate Planner and Exec cells", () => {
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 5000,
      totalTokens: 50_000,
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Exec")).toBeInTheDocument();
  });

  it("shows planner cost in the Planner cell", () => {
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 5000,
      totalTokens: 50_000,
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    expect(valueInCell(statCell("Planner"))).toBe("$0.30");
  });

  it("derives Exec cost as totalCost - plannerCost", () => {
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 5000,
      totalTokens: 50_000,
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    // 1.50 - 0.30 = 1.20
    expect(valueInCell(statCell("Exec"))).toBe("$1.20");
  });

  it("treats missing plannerCost as zero (Planner $0.00, Exec = totalCost)", () => {
    const flight = makeFlight({
      totalCost: 1.5,
      totalTokens: 50_000,
      // No plannerCost / plannerTokens / plannerProvider set.
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    expect(valueInCell(statCell("Planner"))).toBe("$0.00");
    expect(valueInCell(statCell("Exec"))).toBe("$1.50");
  });

  it("clamps Exec to $0.00 when plannerCost exceeds totalCost (defensive)", () => {
    // Defensive invariant: backend should never let plannerCost > totalCost
    // (totalCost is supposed to be planner+exec), but if it ever does we
    // clamp via Math.max(0, ...) rather than render a negative dollar
    // amount. This test pins that contract.
    const flight = makeFlight({
      totalCost: 0.1,
      plannerCost: 0.5,
      plannerTokens: 1000,
      totalTokens: 1000,
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    expect(valueInCell(statCell("Planner"))).toBe("$0.50");
    expect(valueInCell(statCell("Exec"))).toBe("$0.00");
  });

  it("shows token chip on Planner cell when plannerProvider is claude-oauth", () => {
    // E8-ACCUM is adding `plannerProvider` to the Flight DTO. The E8-UI
    // change reads it via a narrowed cast so the FE works pre-/post-
    // accum-landing. Test the OAuth path explicitly.
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 5000,
      totalTokens: 50_000,
    }) as Flight & { plannerProvider?: string };
    flight.plannerProvider = "claude-oauth";
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    const sub = subInCell(statCell("Planner"));
    expect(sub).not.toBeNull();
    // formatTokens(5000) -> "5.0k"
    expect(sub).toContain("5.0k");
    expect(sub).toContain("tokens");
    // No "(API)" label on the OAuth path.
    expect(sub).not.toContain("(API)");
  });

  it("shows (API) sub-label on Planner cell when plannerProvider is api-claude", () => {
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 5000,
      totalTokens: 50_000,
    }) as Flight & { plannerProvider?: string };
    flight.plannerProvider = "api-claude";
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    const sub = subInCell(statCell("Planner"));
    expect(sub).toBe("(API)");
  });

  it("defaults to (API) sub-label when plannerProvider is unset (non-OAuth assumption)", () => {
    // The OAuth branch is only entered for the literal string
    // "claude-oauth"; everything else (including undefined) falls through
    // to the (API) branch. This pins the contract.
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 0,
      totalTokens: 50_000,
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    const sub = subInCell(statCell("Planner"));
    expect(sub).toBe("(API)");
  });

  it("keeps the Tokens cell as the cumulative flight total (not planner-only)", () => {
    // `Tokens` is the existing total-flight token cell. The cost split
    // adds Planner/Exec but must NOT change Tokens — that one rolls up
    // planner + executor. This protects against accidental swap.
    const flight = makeFlight({
      totalCost: 1.5,
      plannerCost: 0.3,
      plannerTokens: 5000,
      totalTokens: 50_000,
    });
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;

    render(<FlightsView />);

    // formatTokens(50_000) -> "50.0k"
    expect(valueInCell(statCell("Tokens"))).toBe("50.0k");
  });

  it("surfaces scheduler stalls in the flight pane and lets the user retry", () => {
    const flight = makeFlight();
    mocks.flightState.flights = [flight];
    mocks.flightState.activeFlightId = flight.id;
    mocks.schedulerState.lastError =
      "Flight scheduler backend failed 3 times in a row; dispatch loop paused.";

    render(<FlightsView />);

    expect(screen.getByRole("alert")).toHaveTextContent("Flight scheduler backend failed");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(mocks.schedulerState.startLoop).toHaveBeenCalledOnce();
  });
});
