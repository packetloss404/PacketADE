/**
 * F2 — Accept and Reject are terminal and both reach `git worktree remove
 * --force`, so neither may fire from a single click. These cover the confirm
 * binding (nothing mutates until the user confirms), the consequences the
 * confirm states, and the post-accept Land / Open PR actions that give accepted
 * work a route into the codebase.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setAttemptStatus: vi.fn(),
  landAttempt: vi.fn(),
  publishAttemptPr: vi.fn(),
  cancelAttempt: vi.fn(),
  inspectAttemptWorktree: vi.fn(),
}));

vi.mock("@/stores/asyncFlightStore", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/asyncFlightStore")>();
  const state = {
    setAttemptStatus: mocks.setAttemptStatus,
    landAttempt: mocks.landAttempt,
    publishAttemptPr: mocks.publishAttemptPr,
    cancelAttempt: mocks.cancelAttempt,
    retryReviewGate: vi.fn(),
    overrideReviewGate: vi.fn(),
    sendReviewFindingsToBuilder: vi.fn(),
  };
  return {
    ...actual,
    inspectAttemptWorktree: (...args: unknown[]) => mocks.inspectAttemptWorktree(...args),
    useAsyncFlightStore: (selector: (s: typeof state) => unknown) => selector(state),
  };
});

import { AttemptTile } from "@/components/flights/AttemptTile";
import { describeAttemptDecisionImpact, attemptLandability } from "@/stores/asyncFlightStore";
import type { Attempt, Flight } from "@/types/flight";

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  const now = Date.now();
  return {
    id: "flight-1",
    title: "Ship the thing",
    objective: "Ship it",
    status: "review",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: now,
    updatedAt: now,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "attempt-1",
    flightId: "flight-1",
    target: { kind: "local", basePath: "/repo", worktreePath: "/repo/.pkt-worktrees/attempt-1" },
    agentConfigId: "api-claude",
    model: "claude-sonnet-5",
    provider: "anthropic",
    branch: "pkt/attempt-1",
    baseBranch: "main",
    sessionId: "session-1",
    status: "reviewing",
    cost: 0,
    tokens: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectAttemptWorktree.mockResolvedValue("clean");
  mocks.setAttemptStatus.mockResolvedValue(undefined);
  mocks.landAttempt.mockResolvedValue({ landed: true, commitSha: "abc1234def", message: "" });
  mocks.publishAttemptPr.mockResolvedValue(undefined);
});

describe("AttemptTile accept/reject confirmation", () => {
  it("does not settle the attempt when Accept is clicked — it opens a confirm first", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("Accept this attempt?")).toBeInTheDocument();
    await waitFor(() => expect(mocks.inspectAttemptWorktree).toHaveBeenCalled());
  });

  it("settles as completed only from the confirm button", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    const confirm = await screen.findByRole("button", { name: "Accept attempt" });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.setAttemptStatus).toHaveBeenCalledWith("flight-1", "attempt-1", "completed"),
    );
  });

  it("settles as failed only from the Reject confirm button", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
    expect(await screen.findByText("Reject this attempt?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reject attempt" }));
    await waitFor(() =>
      expect(mocks.setAttemptStatus).toHaveBeenCalledWith("flight-1", "attempt-1", "failed"),
    );
  });

  it("backing out of the confirm mutates nothing", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    await screen.findByText("Accept this attempt?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Accept this attempt?")).not.toBeInTheDocument());
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
  });

  it("renders as a labelled modal dialog and backs out on Escape", async () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Accept this attempt?");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.setAttemptStatus).not.toHaveBeenCalled();
  });

  it("names the uncommitted work the forced removal will destroy", async () => {
    mocks.inspectAttemptWorktree.mockResolvedValue("dirty");
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /accept/i }));

    expect(await screen.findByText(/uncommitted changes right now/i)).toBeInTheDocument();
    expect(screen.getByText(/is kept — use Land or Open PR/i)).toBeInTheDocument();
  });

  it("shows the probe as still running rather than an empty consequence list", async () => {
    mocks.inspectAttemptWorktree.mockReturnValue(new Promise(() => {}));
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    expect(await screen.findByText(/Checking this attempt's worktree/i)).toBeInTheDocument();
  });

  it("keeps the reviewer gate as the Accept gate", () => {
    const flight = makeFlight({
      reviewGatePolicy: {
        enabled: true,
        reviewerAgentConfigId: "api-openai-agents",
        reviewerModel: "gpt-5",
        acceptanceCriteria: ["tests pass"],
      },
    });
    render(<AttemptTile flight={flight} attempt={makeAttempt()} />);

    expect(screen.getByRole("button", { name: /accept/i })).toBeDisabled();
  });
});

describe("AttemptTile land / open PR", () => {
  it("offers Land and Open PR once the attempt is accepted", () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    expect(screen.getByRole("button", { name: /land/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /open pr/i })).toBeEnabled();
  });

  it("offers neither while the attempt is still under review", () => {
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt()} />);

    expect(screen.queryByRole("button", { name: /^land$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open pr/i })).not.toBeInTheDocument();
  });

  it("lands the accepted branch and reports the resulting commit", async () => {
    mocks.landAttempt.mockResolvedValue({
      landed: true,
      commitSha: "abc1234def",
      message: "Landed pkt/attempt-1 as abc1234.",
    });
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    fireEvent.click(screen.getByRole("button", { name: /land/i }));

    await waitFor(() => expect(mocks.landAttempt).toHaveBeenCalledWith("flight-1", "attempt-1"));
    expect(await screen.findByText("Landed pkt/attempt-1 as abc1234.")).toBeInTheDocument();
  });

  it("reports an empty branch as a failure, not as a landing", async () => {
    mocks.landAttempt.mockResolvedValue({
      landed: false,
      message: "Nothing to land — pkt/attempt-1 has no commits the checkout doesn't already have.",
    });
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    fireEvent.click(screen.getByRole("button", { name: /land/i }));

    expect(await screen.findByText(/Nothing to land/i)).toHaveClass("text-accent-red");
  });

  it("surfaces a refused land instead of claiming success", async () => {
    mocks.landAttempt.mockRejectedValue(
      new Error("Cannot land: the root checkout has 2 uncommitted change(s)."),
    );
    render(<AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />);

    fireEvent.click(screen.getByRole("button", { name: /land/i }));

    expect(await screen.findByText(/root checkout has 2 uncommitted/i)).toBeInTheDocument();
  });

  it("opens a draft PR on demand and disables the action once one exists", async () => {
    const { unmount } = render(
      <AttemptTile flight={makeFlight()} attempt={makeAttempt({ status: "completed" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open pr/i }));
    await waitFor(() =>
      expect(mocks.publishAttemptPr).toHaveBeenCalledWith("flight-1", "attempt-1"),
    );
    unmount();

    render(
      <AttemptTile
        flight={makeFlight()}
        attempt={makeAttempt({ status: "completed", draftPrNumber: 7 })}
      />,
    );
    expect(screen.getByRole("button", { name: /open pr/i })).toBeDisabled();
  });

  it("disables Land for an SSH attempt, which cannot merge into the local checkout", () => {
    const attempt = makeAttempt({
      status: "completed",
      target: { kind: "ssh", serverId: "srv-1", basePath: "/srv", worktreePath: "/srv/wt" },
    });
    render(<AttemptTile flight={makeFlight()} attempt={attempt} />);

    expect(screen.getByRole("button", { name: /land/i })).toBeDisabled();
    expect(attemptLandability(attempt).reason).toMatch(/SSH host/i);
  });
});

describe("describeAttemptDecisionImpact", () => {
  it("reports the probe as pending rather than as clean", () => {
    expect(describeAttemptDecisionImpact("accept", makeAttempt(), null)).toEqual([
      "Checking this attempt's worktree for uncommitted work…",
    ]);
  });

  it("always states the forced worktree removal and the surviving branch", () => {
    const lines = describeAttemptDecisionImpact("reject", makeAttempt(), "clean");
    expect(lines.join(" ")).toContain("/repo/.pkt-worktrees/attempt-1");
    expect(lines.join(" ")).toContain("force-removed");
    expect(lines.join(" ")).toContain("Branch pkt/attempt-1 is kept");
  });

  it("mentions the draft PR only when the flight publishes and none exists yet", () => {
    const publishing = makeFlight({ publishAttemptsAsPrs: true });
    expect(
      describeAttemptDecisionImpact("accept", makeAttempt(), "clean", publishing).join(" "),
    ).toContain("draft PR");
    expect(
      describeAttemptDecisionImpact(
        "accept",
        makeAttempt({ draftPrNumber: 3 }),
        "clean",
        publishing,
      ).join(" "),
    ).not.toContain("draft PR");
    expect(
      describeAttemptDecisionImpact("accept", makeAttempt(), "clean", makeFlight()).join(" "),
    ).not.toContain("draft PR");
  });

  it("warns when the worktree could not be checked", () => {
    expect(describeAttemptDecisionImpact("accept", makeAttempt(), "unknown").join(" ")).toContain(
      "could not be checked",
    );
  });
});
