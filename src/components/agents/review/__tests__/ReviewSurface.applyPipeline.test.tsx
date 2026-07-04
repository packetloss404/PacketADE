/**
 * ReviewSurface apply-pipeline routing (consensus P1-8).
 *
 * THE contract: every decision on a gated (pending) edit routes through
 * `respondEdit` — Keep applies (merging per-hunk selections through
 * lib/hunkDiff's `applyAcceptedHunks`), Undo rejects, and a Keep with
 * nothing kept degrades to a reject so the model is never lied to. There
 * is NO direct-to-disk apply side door: `writeFileContents` must never
 * fire for a pending edit. Post-hoc (already applied) hunks are the one
 * place disk writes are legitimate — per-hunk Undo restores the recorded
 * baseline lines, and never fakes a protocol response.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConversation,
  PendingEdit,
} from "@/types/agent-conversation";

const respondEditMock = vi.hoisted(() => vi.fn());
const writeFileContentsMock = vi.hoisted(() => vi.fn());
const readFileForDiffMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  respondEdit: (...args: unknown[]) => respondEditMock(...args),
  respondPermission: vi.fn(),
  cancelPendingTools: vi.fn(),
  writeFileContents: (...args: unknown[]) => writeFileContentsMock(...args),
  readFileForDiff: (...args: unknown[]) => readFileForDiffMock(...args),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: vi.fn(() => ({
      findTaskBySessionId: vi.fn(() => null),
    })),
  },
}));

vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: {
    getState: vi.fn(() => ({
      onTaskApprovalNeeded: vi.fn().mockResolvedValue(undefined),
      onTaskApprovalResolved: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

// Selector-style stub for the task store (the full store drags tauri IPC
// wiring into the test). CommentableRow and the surface only read.
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

function makeConversation(
  overrides: Partial<AgentConversation> = {},
): AgentConversation {
  return {
    id: "conv-1",
    title: "Review pipeline",
    agent: "api-claude",
    projectPath: "/proj",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

function seedPendingEdit(edit: Partial<PendingEdit> = {}) {
  useAgentApprovalStore.getState().addPendingEdit("conv-1", {
    id: "edit-1",
    path: "src/foo.ts",
    content: AFTER,
    before: BEFORE,
    ...edit,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  respondEditMock.mockResolvedValue(undefined);
  writeFileContentsMock.mockResolvedValue(undefined);
  readFileForDiffMock.mockResolvedValue(null);
  taskStore.state.conversations = [makeConversation()];
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

describe("ReviewSurface — pending edits route through respondEdit only", () => {
  it("Keep with every hunk kept applies without merged content and never touches disk", async () => {
    seedPendingEdit();
    render(<ReviewSurface conversationId="conv-1" embedded />);

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() =>
      expect(respondEditMock).toHaveBeenCalledWith(
        "conv-1",
        "edit-1",
        "apply",
        undefined,
      ),
    );
    expect(writeFileContentsMock).not.toHaveBeenCalled();
  });

  it("Keep with a subset merges via applyAcceptedHunks and passes the merged content", async () => {
    seedPendingEdit();
    render(<ReviewSurface conversationId="conv-1" embedded />);

    // Two replace hunks (line2 and line5). Un-keep the second.
    fireEvent.click(screen.getByRole("checkbox", { name: /keep hunk 2/i }));
    fireEvent.click(screen.getByRole("button", { name: "Keep 1/2" }));

    await waitFor(() =>
      expect(respondEditMock).toHaveBeenCalledWith(
        "conv-1",
        "edit-1",
        "apply",
        "line1\nCHANGED2\nline3\nline4\nline5\n",
      ),
    );
    expect(writeFileContentsMock).not.toHaveBeenCalled();
  });

  it("Undo all rejects through respondEdit and never touches disk", async () => {
    seedPendingEdit();
    render(<ReviewSurface conversationId="conv-1" embedded />);

    fireEvent.click(screen.getByRole("button", { name: /undo all/i }));

    await waitFor(() =>
      expect(respondEditMock).toHaveBeenCalledWith("conv-1", "edit-1", "reject", undefined),
    );
    expect(writeFileContentsMock).not.toHaveBeenCalled();
  });

  it("Keep with every hunk un-kept degrades to reject (the model is told the truth)", async () => {
    seedPendingEdit();
    render(<ReviewSurface conversationId="conv-1" embedded />);

    fireEvent.click(screen.getByRole("checkbox", { name: /keep hunk 1/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /keep hunk 2/i }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() =>
      expect(respondEditMock).toHaveBeenCalledWith("conv-1", "edit-1", "reject", undefined),
    );
    expect(writeFileContentsMock).not.toHaveBeenCalled();
  });

  it("a new file (no before) keeps as a plain apply", async () => {
    seedPendingEdit({ before: undefined, content: "brand new\n" });
    render(<ReviewSurface conversationId="conv-1" embedded />);

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() =>
      expect(respondEditMock).toHaveBeenCalledWith(
        "conv-1",
        "edit-1",
        "apply",
        undefined,
      ),
    );
    expect(writeFileContentsMock).not.toHaveBeenCalled();
  });
});

describe("ReviewSurface — one section per file, pending outranks applied", () => {
  it("renders a gated file that is already in the transcript ONCE, and counts it once", async () => {
    // Sidecar runtimes put the gated tool call (with input) into the
    // transcript BEFORE approval, so the aggregate sees the same file the
    // pending edit names. It must render as ONE amber pending section —
    // never an extra 'applied' section — and the header must say "1 file".
    taskStore.state.conversations = [
      makeConversation({
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: "",
            timestamp: 1,
            toolCalls: [
              {
                id: "edit-1",
                name: "Write",
                status: "running",
                input: JSON.stringify({
                  file_path: "/proj/src/foo.ts",
                  content: AFTER,
                }),
              },
            ],
          },
        ],
      }),
    ];
    // The pending-edit listener records the baseline and stores the edit
    // with the PROJECT-RELATIVE path (matching the transcript keys).
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/foo.ts", BEFORE, "edit-1");
    seedPendingEdit({ path: "src/foo.ts" });

    render(<ReviewSurface conversationId="conv-1" embedded />);
    // Flush the async aggregate (useDiffTotals) so the header count below
    // reflects the resolved totals, not the pre-aggregate placeholder.
    await act(async () => {});

    expect(screen.getByText(/^1 file$/)).toBeInTheDocument();
    expect(screen.queryByText(/2 files/)).not.toBeInTheDocument();
    expect(screen.getByText("awaiting review")).toBeInTheDocument();
    // No spurious applied section diffing baseline → disk alongside it.
    expect(
      screen.queryByText(/No changes vs\. on-disk content/),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Viewed /)).not.toBeInTheDocument();
    expect(screen.getAllByText("src/foo.ts")).toHaveLength(1);
  });
});

describe("ReviewSurface — Escape handling around the protected comment composer", () => {
  it("Escape inside the line-comment composer cancels the comment WITHOUT closing the surface", async () => {
    seedPendingEdit();
    const onClose = vi.fn();
    render(<ReviewSurface conversationId="conv-1" onClose={onClose} />);

    // Open the hover-`+` composer on the first diff row.
    fireEvent.click(screen.getAllByTitle(/^Comment on /)[0]);
    const input = screen.getByPlaceholderText(/Add a comment/);
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(/Add a comment/)).not.toBeInTheDocument();
  });

  it("Escape while typing in any input leaves the surface open; elsewhere it closes", () => {
    seedPendingEdit();
    const onClose = vi.fn();
    render(<ReviewSurface conversationId="conv-1" onClose={onClose} />);

    // e.g. the main composer visible below the overlay.
    const outsideInput = document.createElement("textarea");
    document.body.appendChild(outsideInput);
    fireEvent.keyDown(outsideInput, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    outsideInput.remove();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewSurface — applied hunk Undo reverts on disk without faking protocol", () => {
  it("per-hunk Undo writes the baseline-restored content and never calls respondEdit", async () => {
    // Applied write_file in the transcript + recorded baseline; disk holds
    // the applied AFTER content.
    taskStore.state.conversations = [
      makeConversation({
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
      }),
    ];
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/foo.ts", BEFORE, "tc-1");
    readFileForDiffMock.mockResolvedValue(AFTER);

    render(<ReviewSurface conversationId="conv-1" embedded />);

    // Wait for the disk read to resolve and the two hunks to render.
    const undoButtons = await screen.findAllByRole("button", {
      name: /^undo$/i,
    });
    expect(undoButtons).toHaveLength(2);

    await act(async () => {
      fireEvent.click(undoButtons[0]);
    });

    await waitFor(() =>
      expect(writeFileContentsMock).toHaveBeenCalledWith(
        "/proj/src/foo.ts",
        "/proj",
        // Hunk 1 (line2) reverted; hunk 2 (line5) kept.
        "line1\nline2\nline3\nline4\nCHANGED5\n",
      ),
    );
    expect(respondEditMock).not.toHaveBeenCalled();
  });
});
