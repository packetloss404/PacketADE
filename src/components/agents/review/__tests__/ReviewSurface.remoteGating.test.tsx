/**
 * D3 (audit finding P0-4) — applied-file Review and Undo are LOCAL-disk
 * operations. On an SSH-backed conversation `projectPath` is the REMOTE path,
 * so reading or writing it would hit an unrelated local file. The gate:
 *
 *  - no `read_file_for_diff` is issued for a remote conversation;
 *  - the file-level "Undo all" stays VISIBLE but disabled (discoverable), and
 *    clicking it never writes;
 *  - a remote file with no wire-recorded baseline renders an explicit
 *    "not yet available for SSH workspaces" notice instead of a fake diff;
 *  - a remote file WITH a baseline still renders a truthful read-only diff.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

const respondEditMock = vi.hoisted(() => vi.fn());
const writeFileContentsMock = vi.hoisted(() => vi.fn());
const readFileForDiffMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  respondEdit: (...args: unknown[]) => respondEditMock(...args),
  respondPermission: vi.fn(),
  cancelPendingTools: vi.fn(),
  writeFileContents: (...args: unknown[]) => writeFileContentsMock(...args),
  readFileForDiff: (...args: unknown[]) => readFileForDiffMock(...args),
  saveServersSlice: vi.fn(),
}));

const taskStore = vi.hoisted(() => ({
  state: {
    conversations: [] as AgentConversation[],
    addDiffComment: vi.fn(),
  },
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof taskStore.state) => unknown) =>
    selector(taskStore.state),
}));

import { ReviewSurface } from "@/components/agents/review/ReviewSurface";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useEditBaselineStore } from "@/stores/editBaselineStore";
import { useReviewStore } from "@/stores/reviewStore";

const BEFORE = "line1\nline2\nline3\nline4\nline5\n";
const AFTER = "line1\nCHANGED2\nline3\nline4\nCHANGED5\n";

function makeConversation(remote: boolean): AgentConversation {
  return {
    id: "conv-1",
    title: "Remote review",
    agent: "api-claude-oauth",
    projectPath: remote ? "/home/ian/proj" : "/proj",
    status: "idle",
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        content: "",
        timestamp: 1,
        toolCalls: [
          {
            id: "tc-1",
            name: "write_file",
            status: "done",
            input: JSON.stringify({ path: "src/foo.ts", content: AFTER }),
          },
        ],
      },
    ],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...(remote
      ? {
          sshTarget: {
            id: "srv-1",
            name: "box",
            host: "10.0.0.5",
            user: "ian",
            remotePath: "/home/ian/proj",
          },
        }
      : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  respondEditMock.mockResolvedValue(undefined);
  writeFileContentsMock.mockResolvedValue(undefined);
  readFileForDiffMock.mockResolvedValue(AFTER);
  useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
  useEditBaselineStore.setState({
    byConversation: new Map(),
    byToolCall: new Map(),
  });
  useReviewStore.setState({
    open: false,
    conversationId: null,
    focusPath: null,
    viewed: {},
  });
});

describe("ReviewSurface — SSH conversations never touch local disk (D3 / P0-4)", () => {
  it("renders a truthful baseline diff but disables Undo, and clicking it writes nothing", async () => {
    taskStore.state.conversations = [makeConversation(true)];
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/foo.ts", BEFORE, "tc-1");

    render(<ReviewSurface conversationId="conv-1" embedded />);

    const undoAll = await screen.findByRole("button", { name: /undo all/i });
    expect(undoAll).toBeDisabled();
    expect(undoAll).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      fireEvent.click(undoAll);
    });
    expect(writeFileContentsMock).not.toHaveBeenCalled();
    expect(respondEditMock).not.toHaveBeenCalled();

    // Per-hunk Undo controls are not offered at all on remote files.
    expect(screen.queryByRole("button", { name: /^undo$/i })).toBeNull();
    // No local read was ever issued for this remote conversation.
    expect(readFileForDiffMock).not.toHaveBeenCalled();
  });

  it("says so explicitly when a remote file has no recorded baseline", async () => {
    taskStore.state.conversations = [makeConversation(true)];
    // No baseline recorded → the "before" side would have to come from disk.

    render(<ReviewSurface conversationId="conv-1" embedded />);

    expect(
      await screen.findByText(/not yet available for ssh workspaces/i),
    ).toBeTruthy();
    expect(readFileForDiffMock).not.toHaveBeenCalled();
  });

  it("leaves the local path unchanged: Undo is enabled and writes to disk", async () => {
    taskStore.state.conversations = [makeConversation(false)];
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/foo.ts", BEFORE, "tc-1");

    render(<ReviewSurface conversationId="conv-1" embedded />);

    const undoAll = await screen.findByRole("button", { name: /undo all/i });
    expect(undoAll).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(undoAll);
    });
    await waitFor(() =>
      expect(writeFileContentsMock).toHaveBeenCalledWith(
        "/proj/src/foo.ts",
        "/proj",
        BEFORE,
      ),
    );
  });
});
