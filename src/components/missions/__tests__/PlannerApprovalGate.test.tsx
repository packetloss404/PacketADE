import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getMissionApprovals: vi.fn(),
  resolveMissionApproval: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/tauri", () => ({
  getMissionApprovals: (...args: unknown[]) => mocks.getMissionApprovals(...args),
  injectPlannerTurn: vi.fn().mockResolvedValue(undefined),
  pauseMissionPlanner: vi.fn().mockResolvedValue(undefined),
  resolveMissionApproval: (...args: unknown[]) => mocks.resolveMissionApproval(...args),
  resumeMissionPlanner: vi.fn().mockResolvedValue(undefined),
  startMissionPlanner: vi.fn().mockResolvedValue("planner-session"),
  stopMissionPlanner: vi.fn().mockResolvedValue(undefined),
  triggerPlannerDecomposition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications", () => ({
  notifyMissionPlannerRateLimited: vi.fn().mockResolvedValue(undefined),
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

import { PlannerApprovalGate } from "@/components/missions/PlannerApprovalGate";
import { useMissionPlannerStore } from "@/stores/missionPlannerStore";

describe("PlannerApprovalGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMissionPlannerStore.setState({
      runtimes: new Map(),
      pendingApprovals: new Map(),
    });
    mocks.getMissionApprovals.mockResolvedValue([]);
    mocks.resolveMissionApproval.mockResolvedValue(undefined);
  });

  it("hydrates persisted approvals when the gate mounts", async () => {
    mocks.getMissionApprovals.mockResolvedValueOnce([
      {
        id: "approval-1",
        missionId: "mission-1",
        question: "Approve the restart plan?",
        options: ["Approve"],
        awaitingSince: 1_000,
      },
    ]);

    render(<PlannerApprovalGate missionId="mission-1" />);

    expect(await screen.findByText("Approve the restart plan?")).toBeInTheDocument();
    expect(mocks.getMissionApprovals).toHaveBeenCalledWith("mission-1");
  });
});
