/**
 * Issues were the one entity you could create but never remove: `deleteIssue`
 * existed in the store with zero UI callers, and `IssueCommentList` deleted a
 * comment on the first click with no confirm at all.
 *
 * These tests pin the fixed behaviour:
 *   1. the destructive click alone mutates nothing — it opens the shared
 *      `ConfirmDeleteModal`;
 *   2. cancelling leaves the store (and localStorage) untouched;
 *   3. confirming deletes, persists, and cleans up the FLIGHT side of the
 *      bidirectional `Flight.issueIds` ⇄ `Issue.flightId` link;
 *   4. deleting the issue whose detail panel is open closes that panel instead
 *      of leaving it pointed at a record that no longer exists;
 *   5. no native `window.confirm` anywhere (the source-level fence for that
 *      lives in `scripts/confirm-idiom.test.mjs`).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import type { Flight } from "@/types/flight";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

// The spec-import modal reaches for Tauri IPC on mount paths we don't exercise.
vi.mock("@/components/issues/SpecImportModal", () => ({ SpecImportModal: () => null }));

import { IssueBoard } from "@/components/issues/IssueBoard";
import { IssueCommentList } from "@/components/issues/IssueCommentList";
import { useIssueStore, type Issue } from "@/stores/issueStore";
import { useFlightStore } from "@/stores/flightStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";

const issues = () => useIssueStore.getState().issues;

function seedIssue(overrides: Partial<Issue> = {}): Issue {
  const created = useIssueStore.getState().addIssue({
    title: "Fix the login redirect",
    description: "d",
    status: "todo",
    priority: "medium",
    labels: [],
    epic: null,
    acceptanceCriteria: [],
    blockedBy: [],
    blocks: [],
    comments: [],
  });
  if (Object.keys(overrides).length > 0) {
    useIssueStore.getState().updateIssue(created.id, overrides);
  }
  return useIssueStore.getState().issues.find((i) => i.id === created.id)!;
}

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    title: "Auth hardening",
    objective: "o",
    status: "active",
    priority: "medium",
    projectPath: "/test",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function storedIssues(): Issue[] {
  const raw = localStorage.getItem("packetbench:issues");
  return raw ? (JSON.parse(raw).issues as Issue[]) : [];
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  useIssueStore.setState({
    issues: [],
    nextTicketNum: 1,
    ticketPrefix: "PKT",
    epics: [],
    labels: [],
  });
  useFlightStore.setState({ flights: [], activeFlightId: null });
  useWorkspaceStore.setState({ workspaces: [] });
  // jsdom's window.confirm throws "not implemented"; stub it so an accidental
  // native confirm would be visible as a call rather than as a crash.
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  // Every flow in this file must be styled-modal only.
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

describe("IssueBoard — deleting an issue from its card", () => {
  it("requires the confirm; cancel leaves the board untouched", () => {
    const issue = seedIssue();
    render(<IssueBoard />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByRole("button", { name: `Delete issue ${issue.ticketId}` }));
    expect(issues()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Delete issue?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(issues()).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Delete issue?" })).not.toBeInTheDocument();
  });

  it("deletes and persists only from the confirm button", async () => {
    const issue = seedIssue();
    render(<IssueBoard />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByRole("button", { name: `Delete issue ${issue.ticketId}` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(issues()).toHaveLength(0);
    // Persisted through the same save path as every other issue mutation.
    expect(storedIssues()).toHaveLength(0);
    await waitFor(() => {
      expect(screen.queryByText(issue.title)).not.toBeInTheDocument();
    });
  });

  it("names the issue and discloses what else the delete takes with it", () => {
    const issue = seedIssue();
    useIssueStore.getState().addIssueComment(issue.id, "first note");
    useIssueStore.getState().addIssueComment(issue.id, "second note");
    useIssueStore.getState().addCriterion(issue.id, "redirect lands on /home");
    useIssueStore.getState().updateIssue(issue.id, {
      flightId: "flight-1",
      workspaceId: "ws-1",
      sessionId: "pane-1",
    });
    useFlightStore.setState({ flights: [makeFlight({ issueIds: [issue.id] })] });
    useWorkspaceStore.setState({
      workspaces: [{ id: "ws-1", name: "auth-fix", projectPath: "/test", panes: [] } as never],
    });

    render(<IssueBoard />, { wrapper: ToastProvider });
    fireEvent.click(screen.getByRole("button", { name: `Delete issue ${issue.ticketId}` }));

    // The record is NAMED, not a bare "Are you sure?".
    expect(screen.getByText(`“${issue.ticketId}: ${issue.title}”`)).toBeInTheDocument();
    expect(screen.getByText("Unlinks it from the flight “Auth hardening”.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "It was sent to the workspace “auth-fix” — that session keeps running; only the issue record goes.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("2 comments on this issue are deleted with it.")).toBeInTheDocument();
    expect(screen.getByText("1 acceptance criterion is deleted with it.")).toBeInTheDocument();
  });

  it("unlinks the deleted issue from the flight that still names it", async () => {
    const issue = seedIssue({ flightId: "flight-1" });
    useFlightStore.setState({ flights: [makeFlight({ issueIds: [issue.id, "issue-other"] })] });

    render(<IssueBoard />, { wrapper: ToastProvider });
    fireEvent.click(screen.getByRole("button", { name: `Delete issue ${issue.ticketId}` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Both halves of the link are cleaned: the issue is gone and no flight is
    // left holding a dangling id.
    expect(issues()).toHaveLength(0);
    await waitFor(() => {
      expect(useFlightStore.getState().flights[0].issueIds).not.toContain(issue.id);
    });
  });

  it("clears dependency edges on the surviving issues", async () => {
    const blocker = seedIssue({ title: "Blocker" });
    const blocked = seedIssue({ title: "Blocked" });
    useIssueStore.getState().addBlockedBy(blocked.id, blocker.id);
    expect(issues().find((i) => i.id === blocked.id)!.blockedBy).toContain(blocker.id);

    render(<IssueBoard />, { wrapper: ToastProvider });
    fireEvent.click(screen.getByRole("button", { name: `Delete issue ${blocker.ticketId}` }));
    expect(screen.getByText("1 dependency link on other issues is cleared.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(issues().find((i) => i.id === blocked.id)!.blockedBy).not.toContain(blocker.id);
    });
  });
});

describe("IssueDetail — deleting the issue you have open", () => {
  it("confirms first, then deletes and closes the detail panel", async () => {
    const issue = seedIssue();
    render(<IssueBoard />, { wrapper: ToastProvider });

    // Open the detail panel from the card.
    fireEvent.click(screen.getByText(issue.title));
    expect(await screen.findByText(`${issue.ticketId}: ${issue.title}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete issue" }));
    expect(issues()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Delete issue?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(issues()).toHaveLength(1);
    // Still open — cancel backs out of the confirm, not out of the panel.
    expect(screen.getByRole("button", { name: "Delete issue" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete issue" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(issues()).toHaveLength(0);
    // No blank detail pane left behind, and no empty modal shell.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Delete issue" })).not.toBeInTheDocument();
    });
    expect(screen.queryByText(`${issue.ticketId}: ${issue.title}`)).not.toBeInTheDocument();
  });

  it("closes itself when the open issue is deleted out from under it", async () => {
    const issue = seedIssue();
    render(<IssueBoard />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByText(issue.title));
    expect(await screen.findByText(`${issue.ticketId}: ${issue.title}`)).toBeInTheDocument();

    // Any other store writer (a card delete, an agent, a sync) can remove it.
    act(() => {
      useIssueStore.getState().deleteIssue(issue.id);
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Delete issue" })).not.toBeInTheDocument();
    });
  });
});

describe("IssueCommentList — deleting a comment", () => {
  it("requires the confirm; cancel keeps the comment", () => {
    const issue = seedIssue();
    useIssueStore.getState().addIssueComment(issue.id, "ship it");
    const comments = () => issues().find((i) => i.id === issue.id)!.comments ?? [];

    const { rerender } = render(<IssueCommentList issueId={issue.id} comments={comments()} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete comment by user" }));
    expect(comments()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Delete comment?" })).toBeInTheDocument();
    // Names the comment it is about to destroy.
    expect(screen.getByText("“ship it”")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(comments()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete comment by user" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(comments()).toHaveLength(0);
    // Persisted through the issue's own save path.
    expect(storedIssues().find((i) => i.id === issue.id)!.comments).toHaveLength(0);

    rerender(<IssueCommentList issueId={issue.id} comments={comments()} />);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  });

  it("deletes only the comment that was clicked", () => {
    const issue = seedIssue();
    useIssueStore.getState().addIssueComment(issue.id, "keep me");
    const second = useIssueStore.getState().addIssueComment(issue.id, "delete me", "agent")!;
    const comments = () => issues().find((i) => i.id === issue.id)!.comments ?? [];

    render(<IssueCommentList issueId={issue.id} comments={comments()} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete comment by agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(comments()).toHaveLength(1);
    expect(comments()[0].id).not.toBe(second.id);
  });
});
