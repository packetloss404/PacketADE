import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getFlightApprovals: vi.fn(),
  resolveFlightApproval: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/tauri", () => ({
  getFlightApprovals: (...args: unknown[]) => mocks.getFlightApprovals(...args),
  injectPlannerTurn: vi.fn().mockResolvedValue(undefined),
  pauseFlightPlanner: vi.fn().mockResolvedValue(undefined),
  resolveFlightApproval: (...args: unknown[]) => mocks.resolveFlightApproval(...args),
  resumeFlightPlanner: vi.fn().mockResolvedValue(undefined),
  startFlightPlanner: vi.fn().mockResolvedValue("planner-session"),
  stopFlightPlanner: vi.fn().mockResolvedValue(undefined),
  triggerPlannerDecomposition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications", () => ({
  notifyFlightPlannerRateLimited: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: vi.fn(() => ({
      flights: [],
      hydrateFromBackend: vi.fn().mockResolvedValue(undefined),
      updateFlight: vi.fn(),
    })),
  },
}));

vi.mock("@/components/common/MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { PlannerApprovalGate } from "@/components/flights/PlannerApprovalGate";
import { useFlightPlannerStore } from "@/stores/flightPlannerStore";

describe("PlannerApprovalGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlightPlannerStore.setState({
      runtimes: new Map(),
      pendingApprovals: new Map(),
    });
    mocks.getFlightApprovals.mockResolvedValue([]);
    mocks.resolveFlightApproval.mockResolvedValue(undefined);
  });

  it("hydrates persisted approvals when the gate mounts", async () => {
    mocks.getFlightApprovals.mockResolvedValueOnce([
      {
        id: "approval-1",
        flightId: "flight-1",
        question: "Approve the restart plan?",
        options: ["Approve"],
        awaitingSince: 1_000,
      },
    ]);

    render(<PlannerApprovalGate flightId="flight-1" />);

    expect(await screen.findByText("Approve the restart plan?")).toBeInTheDocument();
    expect(mocks.getFlightApprovals).toHaveBeenCalledWith("flight-1");
  });
});
