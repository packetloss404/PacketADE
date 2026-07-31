/**
 * The confirm is the "surface" half of "Discard, surface the confirm" — the
 * dialog must state the worktree consequence BEFORE the destructive click, and
 * must mutate nothing when the user backs out.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getGitStatusMock = vi.fn();
const deleteConversationMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  getGitStatus: (...args: unknown[]) => getGitStatusMock(...args),
}));

const storeState = vi.hoisted(() => ({
  conversations: [] as unknown[],
  deleteConversation: (..._args: unknown[]) => undefined as unknown,
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}));

import { ConfirmDeleteConversationModal } from "@/components/agents/ConfirmDeleteConversationModal";
import { ToastProvider } from "@/components/ui/Toast";

function worktreeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    title: "Fix login",
    projectPath: "/repo/.pkt-worktrees/conv-1",
    createdAt: 1,
    worktree: {
      basePath: "/repo",
      worktreePath: "/repo/.pkt-worktrees/conv-1",
      branch: "pkt/conv-1",
      createdAt: 1,
      state: "active",
    },
    ...overrides,
  };
}

function renderModal(onClose = vi.fn()) {
  return render(
    <ToastProvider>
      <ConfirmDeleteConversationModal conversationId="conv-1" title="Fix login" onClose={onClose} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteConversationMock.mockResolvedValue(null);
  storeState.deleteConversation = deleteConversationMock;
  storeState.conversations = [worktreeConversation()];
  getGitStatusMock.mockResolvedValue("");
});

describe("ConfirmDeleteConversationModal", () => {
  it("names the worktree path and branch that deletion discards", async () => {
    renderModal();

    expect(await screen.findByText(/Deleting also discards this conversation's worktree/)).toBeInTheDocument();
    expect(
      await screen.findByText("Worktree /repo/.pkt-worktrees/conv-1 will be deleted from disk."),
    ).toBeInTheDocument();
    expect(screen.getByText("Branch pkt/conv-1 will be force-deleted.")).toBeInTheDocument();
  });

  it("discloses UNCOMMITTED CHANGES for a dirty worktree, and says so on the button", async () => {
    getGitStatusMock.mockResolvedValue(" M src/foo.ts\n?? scratch.md\n");
    renderModal();

    expect(
      await screen.findByText(
        "This worktree has UNCOMMITTED CHANGES. They will be permanently lost.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Delete and discard changes" }),
    ).toBeInTheDocument();
  });

  it("discloses that it could not check when git fails", async () => {
    getGitStatusMock.mockRejectedValue(new Error("no git"));
    renderModal();

    expect(await screen.findByText(/Could not check for uncommitted changes/)).toBeInTheDocument();
  });

  it("shows NO worktree warning for a conversation that ran in the project root", async () => {
    storeState.conversations = [
      worktreeConversation({ projectPath: "/repo", worktree: undefined }),
    ];
    renderModal();

    expect(screen.getByText(/will be closed and its history removed/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/worktree/i)).not.toBeInTheDocument();
    expect(getGitStatusMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("deletes NOTHING on cancel", async () => {
    const onClose = vi.fn();
    renderModal(onClose);
    await screen.findByText("Branch pkt/conv-1 will be force-deleted.");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteConversationMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deletes (and discards) only from the confirm button", async () => {
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(await screen.findByRole("button", { name: "Delete and discard worktree" }));

    expect(deleteConversationMock).toHaveBeenCalledWith("conv-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a cleanup failure — the conversation is gone but the worktree is not", async () => {
    deleteConversationMock.mockResolvedValue({
      worktreePath: "/repo/.pkt-worktrees/conv-1",
      branch: "pkt/conv-1",
      discarded: false,
      error: "worktree is locked",
    });
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Delete and discard worktree" }));

    expect(
      await screen.findByText(
        /Conversation deleted, but its worktree could not be discarded: \/repo\/\.pkt-worktrees\/conv-1/,
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about cleanup when the discard succeeded", async () => {
    deleteConversationMock.mockResolvedValue({
      worktreePath: "/repo/.pkt-worktrees/conv-1",
      branch: "pkt/conv-1",
      discarded: true,
    });
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "Delete and discard worktree" }));

    await waitFor(() => expect(deleteConversationMock).toHaveBeenCalled());
    expect(screen.queryByText(/could not be discarded/)).not.toBeInTheDocument();
  });
});
