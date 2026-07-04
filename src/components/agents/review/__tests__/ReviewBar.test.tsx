/**
 * ReviewBar — the persistent "N files · +X/−Y · Review" bar above the
 * composer, and the PROTECTED Y/N keyboard approvals for gated edits
 * (moved here from the old PendingApprovalsSection when pending edits
 * routed into the canonical review surface).
 *
 * Regression gates: Y keeps (respondEdit "apply") / N undoes (respondEdit
 * "reject") the TOP pending edit; the typing-context guard must hold; and
 * permission prompts outrank edits — while any permission is pending the
 * bar's handler stays passive so the approvals section owns the keys.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingEdit } from "@/types/agent-conversation";

vi.mock("@/stores/appStore", () => ({
  useAppStore: (selector: (s: { commandPaletteOpen: boolean }) => unknown) =>
    selector({ commandPaletteOpen: false }),
}));

import { ReviewBar } from "@/components/agents/review/ReviewBar";
import { useReviewStore } from "@/stores/reviewStore";

const respondEdit = vi.fn().mockResolvedValue(undefined);

function makeEdit(id: string, path = "src/foo.ts"): PendingEdit {
  return { id, path, content: "after\n", before: "before\n" };
}

function renderBar({
  pendingEdits = [] as PendingEdit[],
  pendingPermissionCount = 0,
  fileCount = 0,
  paths = new Set<string>(),
} = {}) {
  return render(
    <ReviewBar
      conversationId="conv-1"
      diffTotals={{ fileCount, totalAdds: 3, totalDels: 1, paths }}
      pendingEdits={pendingEdits}
      pendingPermissionCount={pendingPermissionCount}
      respondEdit={respondEdit}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useReviewStore.setState({
    open: false,
    conversationId: null,
    focusPath: null,
    viewed: {},
  });
});

describe("ReviewBar", () => {
  it("renders nothing when there are no changed files and no pending edits", () => {
    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the aggregate and expands the review surface on click", () => {
    renderBar({ fileCount: 2 });
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(useReviewStore.getState().open).toBe(true);
    expect(useReviewStore.getState().conversationId).toBe("conv-1");
  });

  it("counts a gated file already in the aggregate once, never twice", () => {
    // Sidecar runtimes put the gated tool call (with input) in the
    // transcript BEFORE approval, so the aggregate already counts it —
    // one gated edit to one file must read "1 file", not "2 files".
    renderBar({
      fileCount: 1,
      paths: new Set(["src/foo.ts"]),
      pendingEdits: [makeEdit("edit-1", "src/foo.ts")],
    });
    expect(screen.getByText(/1 file\b/)).toBeInTheDocument();
    expect(screen.queryByText(/2 files/)).not.toBeInTheDocument();
  });

  it("counts a gated file the aggregate cannot see yet (in-process input arrives on tool_result)", () => {
    renderBar({
      fileCount: 1,
      paths: new Set(["src/foo.ts"]),
      pendingEdits: [makeEdit("edit-1", "src/other.ts")],
    });
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
  });

  it("Y keeps the top pending edit through respondEdit apply", () => {
    renderBar({ pendingEdits: [makeEdit("edit-1"), makeEdit("edit-2", "b.ts")] });
    fireEvent.keyDown(document.body, { key: "y" });
    expect(respondEdit).toHaveBeenCalledWith("conv-1", "edit-1", "apply");
  });

  it("N undoes the top pending edit through respondEdit reject", () => {
    renderBar({ pendingEdits: [makeEdit("edit-1")] });
    fireEvent.keyDown(document.body, { key: "n" });
    expect(respondEdit).toHaveBeenCalledWith("conv-1", "edit-1", "reject");
  });

  it("ignores Y/N while the user is typing in an input", () => {
    renderBar({ pendingEdits: [makeEdit("edit-1")] });
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "y" });
    fireEvent.keyDown(input, { key: "n" });
    expect(respondEdit).not.toHaveBeenCalled();
    input.remove();
  });

  it("stays passive while permission prompts are pending (they outrank edits)", () => {
    renderBar({
      pendingEdits: [makeEdit("edit-1")],
      pendingPermissionCount: 1,
    });
    fireEvent.keyDown(document.body, { key: "y" });
    expect(respondEdit).not.toHaveBeenCalled();
  });
});
