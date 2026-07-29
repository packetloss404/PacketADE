import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewPacketPanel } from "@/components/workspace/ReviewPacketPanel";
import type { Flight, Task } from "@/types/flight";
import type { FlightReviewTaskRef } from "@/lib/flightReview";

function task(overrides: Partial<Task>): Task {
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
    sessionId: "conv-1",
    createdAt: 1,
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

function flight(tasks: Task[]): Flight {
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
        tasks,
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
  };
}

function ref(overrides: Partial<FlightReviewTaskRef> = {}): FlightReviewTaskRef {
  return {
    flightId: "flight-1",
    flightTitle: "Cost guardrails",
    milestoneId: "ms-1",
    taskId: "task-1",
    taskTitle: "Wire the cost alerts",
    taskStatus: "done",
    agentConfigId: "api-claude",
    filePath: "src/lib/notifications.ts",
    relation: "reported",
    ...overrides,
  };
}

describe("ReviewPacketPanel", () => {
  it("surfaces the review packet summary and diff for a linked task", () => {
    const flights = [
      flight([
        task({
          reviewPacket: {
            id: "rp-1",
            taskId: "task-1",
            flightId: "flight-1",
            milestoneId: "ms-1",
            requestedAt: 1,
            reviewType: "file_write",
            summary: "Added notifyCostThreshold and wired transitions.",
            diff: "@@ -1 +1 @@\n-old\n+new",
            filePaths: ["src/lib/notifications.ts"],
          },
        }),
      ]),
    ];
    render(
      <ReviewPacketPanel
        refs={[ref()]}
        flights={flights}
        onOpenFlight={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Added notifyCostThreshold and wired transitions."),
    ).toBeInTheDocument();
    expect(screen.getByText("File write")).toBeInTheDocument();
    // Diff lines are rendered (added/removed).
    expect(screen.getByText("+new")).toBeInTheDocument();
    expect(screen.getByText("-old")).toBeInTheDocument();
  });

  it("opens the authoritative working-tree diff for the packet file", () => {
    const onOpenDiff = vi.fn();
    const flights = [
      flight([
        task({
          reviewPacket: {
            id: "rp-diff",
            taskId: "task-1",
            flightId: "flight-1",
            milestoneId: "ms-1",
            requestedAt: 1,
            reviewType: "file_write",
            summary: "Review this file.",
            filePaths: ["src/lib/notifications.ts"],
          },
        }),
      ]),
    ];
    render(
      <ReviewPacketPanel
        refs={[ref()]}
        flights={flights}
        onOpenFlight={vi.fn()}
        onOpenDiff={onOpenDiff}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Open diff"));
    expect(onOpenDiff).toHaveBeenCalledWith("src/lib/notifications.ts");
  });

  it("flags a pending approval and deep-links into the flight", () => {
    const onOpenFlight = vi.fn();
    const flights = [flight([task({ status: "approval_needed" })])];
    render(
      <ReviewPacketPanel
        refs={[ref({ taskStatus: "approval_needed" })]}
        flights={flights}
        onOpenFlight={onOpenFlight}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("approval needed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open flight"));
    expect(onOpenFlight).toHaveBeenCalledWith("flight-1");
  });

  it("deep-links to the approval when a live prompt exists for the session", () => {
    const onOpenApproval = vi.fn();
    const flights = [flight([task({ status: "approval_needed", sessionId: "conv-1" })])];
    render(
      <ReviewPacketPanel
        refs={[ref({ taskStatus: "approval_needed", sessionId: "conv-1" })]}
        flights={flights}
        pendingApprovalSessionIds={new Set(["conv-1"])}
        onOpenApproval={onOpenApproval}
        onOpenFlight={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Go to approval"));
    expect(onOpenApproval).toHaveBeenCalledWith("conv-1");
  });

  it("notes when an approval-needed task has no live prompt", () => {
    const flights = [flight([task({ status: "approval_needed", sessionId: "conv-1" })])];
    render(
      <ReviewPacketPanel
        refs={[ref({ taskStatus: "approval_needed", sessionId: "conv-1" })]}
        flights={flights}
        pendingApprovalSessionIds={new Set()}
        onOpenApproval={vi.fn()}
        onOpenFlight={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("Go to approval")).not.toBeInTheDocument();
    expect(screen.getByText("Approval prompt not active in this session.")).toBeInTheDocument();
  });

  it("handles a linked task with no review packet", () => {
    const flights = [flight([task({})])];
    render(
      <ReviewPacketPanel
        refs={[ref()]}
        flights={flights}
        onOpenFlight={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("No review packet recorded for this task yet.")).toBeInTheDocument();
  });

  it("shows a fallback when the flight is gone", () => {
    render(
      <ReviewPacketPanel
        refs={[ref({ flightId: "missing" })]}
        flights={[]}
        onOpenFlight={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText("The linked flight or task is no longer available."),
    ).toBeInTheDocument();
  });
});
