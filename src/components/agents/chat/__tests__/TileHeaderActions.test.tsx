/**
 * TileHeaderActions (P3-S3) — the tile-frame header cluster's responsive +
 * lazy-mount economy.
 *
 * Ruled hybrid model: CSS `@container` handles VISUAL collapse; the heavy
 * controls (ModelSelector, ContextUsageRing, HeaderOverflowMenu) MOUNT LAZILY,
 * only when the overflow toggle is open OR this tile is the zoomed pane — both
 * pre-existing JS state, zero observers. The three cheap chips (AgentModeChip,
 * the Changes/DiffPaneTrigger chip, the amber approval badge) plus close are
 * always present.
 *
 * The heavy controls are mocked to leaf stubs so these assertions isolate the
 * MOUNT decision (heavy controls not in the DOM until overflow/zoom), which is
 * the load-bearing perf guarantee.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

// --- Controllable workspaceStore mock (drives the zoom gate). ---
const wsState = vi.hoisted(() => ({
  zoomedPaneId: null as string | null,
  workspaces: [] as Array<{
    panes: Array<{ id: string; kind?: string; conversationId?: string }>;
  }>,
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (s: typeof wsState) => unknown) => selector(wsState),
}));

// --- Heavy controls → leaf stubs so we assert the mount decision only. ---
vi.mock("@/components/agents/composer/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock("@/components/agents/ContextUsageRing", () => ({
  ContextUsageRing: () => <div data-testid="context-ring" />,
}));
// The menu itself is stubbed, but it re-exposes the two actions the header
// hands it (the inline-controls reveal that used to be a second kebab, and
// Archive, folded in from the tile chrome's kebab) so the wiring is asserted.
vi.mock("@/components/agents/chat/HeaderOverflowMenu", () => ({
  HeaderOverflowMenu: (props: {
    inlineControlsShown?: boolean;
    onToggleInlineControls?: () => void;
    onArchive?: () => void;
  }) => (
    <div data-testid="overflow-menu">
      {props.onToggleInlineControls && (
        <button
          type="button"
          aria-label={
            props.inlineControlsShown
              ? "Hide model & context controls"
              : "Show model & context controls"
          }
          onClick={props.onToggleInlineControls}
        />
      )}
      {props.onArchive && (
        <button type="button" aria-label="Archive conversation" onClick={props.onArchive} />
      )}
    </div>
  ),
}));
vi.mock("@/components/agents/AgentModeChip", () => ({
  AgentModeChip: () => <div data-testid="mode-chip" />,
}));
vi.mock("@/components/agents/DiffPaneTrigger", () => ({
  DiffPaneTrigger: ({ fileCount }: { fileCount: number }) =>
    fileCount > 0 ? <div data-testid="diff-trigger" /> : null,
}));
vi.mock("@/components/agents/hooks/useOllamaModels", () => ({
  useOllamaModels: () => ({ ollamaModels: [], refresh: vi.fn() }),
}));
vi.mock("@/components/agents/paneEvents", () => ({
  OPEN_MODEL_DROPDOWN_EVENT: "open-model-dropdown",
  addPaneControlListener: () => () => {},
}));

import { TileHeaderActions } from "@/components/agents/chat/TileHeaderActions";

function conversation(over: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Tile chat",
    agent: "api-openai",
    projectPath: "/repo",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-4o",
    ...over,
  };
}

function renderTile(
  over: Partial<AgentConversation> = {},
  props: Partial<Parameters<typeof TileHeaderActions>[0]> = {},
) {
  const conv = conversation(over);
  return render(
    <TileHeaderActions
      conversation={conv}
      conversationId={conv.id}
      diffTotals={{ fileCount: 2, totalAdds: 10, totalDels: 3 }}
      previewOpen={false}
      togglePreview={vi.fn()}
      onClose={vi.fn()}
      onCycleMode={vi.fn()}
      onSelectMode={vi.fn()}
      onSetApproveWrites={vi.fn()}
      onChangeModel={vi.fn()}
      onExport={vi.fn()}
      pendingApprovalCount={0}
      {...props}
    />,
  );
}

beforeEach(() => {
  wsState.zoomedPaneId = null;
  wsState.workspaces = [];
});

describe("TileHeaderActions — lazy mount", () => {
  it("at rest (narrow, not zoomed, menu closed) the heavy controls are NOT in the DOM", () => {
    renderTile();
    // Always-visible cheap chips are present.
    expect(screen.getByTestId("mode-chip")).toBeInTheDocument();
    expect(screen.getByTestId("diff-trigger")).toBeInTheDocument();
    expect(screen.getByLabelText("Close conversation")).toBeInTheDocument();
    expect(screen.getByLabelText("Conversation menu")).toBeInTheDocument();
    // Heavy controls are unmounted.
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-ring")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overflow-menu")).not.toBeInTheDocument();
  });

  it("the header offers exactly ONE menu control (no second kebab beside it)", () => {
    renderTile();
    // Buttons at rest: the single menu control + close. Nothing else — the
    // old "More controls" kebab that sat next to the overflow kebab is gone.
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Conversation menu", "Close conversation"]);
  });

  it("the menu control mounts the overflow menu, which reveals/hides the heavy controls", () => {
    renderTile();
    fireEvent.click(screen.getByLabelText("Conversation menu"));
    // One click mounts the menu (it opens itself via openSignal).
    expect(screen.getByTestId("overflow-menu")).toBeInTheDocument();
    // The model/context cluster is revealed from INSIDE that menu.
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show model & context controls"));
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    expect(screen.getByTestId("context-ring")).toBeInTheDocument();
    // And hidden again from the same row.
    fireEvent.click(screen.getByLabelText("Hide model & context controls"));
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
  });

  it("forwards Archive to the overflow menu only when the mount site supplies it", () => {
    const onArchive = vi.fn();
    const { unmount } = renderTile({}, { onArchive });
    fireEvent.click(screen.getByLabelText("Conversation menu"));
    fireEvent.click(screen.getByLabelText("Archive conversation"));
    expect(onArchive).toHaveBeenCalledTimes(1);
    unmount();

    // Agents view passes none → no Archive row (the sidebar row owns it).
    renderTile();
    fireEvent.click(screen.getByLabelText("Conversation menu"));
    expect(screen.queryByLabelText("Archive conversation")).not.toBeInTheDocument();
  });

  it("uses the close label/tooltip the mount site supplies (X must not lie)", () => {
    renderTile(
      {},
      {
        closeLabel: "Close tile",
        closeTooltip:
          "Close tile — removes it from this workspace. The conversation keeps running and stays in the Agents list.",
      },
    );
    expect(screen.getByLabelText("Close tile")).toBeInTheDocument();
    expect(screen.queryByLabelText("Back to list")).not.toBeInTheDocument();
  });

  it("a zoomed tile mounts the heavy controls without opening the menu", () => {
    wsState.zoomedPaneId = "pane-9";
    wsState.workspaces = [
      { panes: [{ id: "pane-9", kind: "conversation", conversationId: "conv-1" }] },
    ];
    renderTile();
    expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    expect(screen.getByTestId("context-ring")).toBeInTheDocument();
    expect(screen.getByTestId("overflow-menu")).toBeInTheDocument();
    // Zoomed tiles always show the cluster, so the reveal row is not offered.
    expect(
      screen.queryByLabelText("Hide model & context controls"),
    ).not.toBeInTheDocument();
  });

  it("a DIFFERENT tile being zoomed does not mount this tile's heavy controls", () => {
    wsState.zoomedPaneId = "pane-9";
    wsState.workspaces = [
      { panes: [{ id: "pane-9", kind: "conversation", conversationId: "other-conv" }] },
    ];
    renderTile();
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
  });

  it("shows the amber approval badge only when there are pending approvals", () => {
    const { rerender } = renderTile({}, { pendingApprovalCount: 0 });
    expect(screen.queryByLabelText(/pending approvals/i)).not.toBeInTheDocument();
    rerender(
      <TileHeaderActions
        conversation={conversation()}
        conversationId="conv-1"
        diffTotals={{ fileCount: 2, totalAdds: 10, totalDels: 3 }}
        previewOpen={false}
        togglePreview={vi.fn()}
        onClose={vi.fn()}
        onCycleMode={vi.fn()}
        onSelectMode={vi.fn()}
        onSetApproveWrites={vi.fn()}
        onChangeModel={vi.fn()}
        onExport={vi.fn()}
        pendingApprovalCount={3}
      />,
    );
    expect(screen.getByLabelText("3 pending approvals")).toBeInTheDocument();
  });

  it("PTY conversations show no api-only chips; close stays; overflow still mounts on demand", () => {
    renderTile({ mode: "pty", agent: "claude-code", model: undefined, provider: undefined });
    expect(screen.queryByTestId("mode-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-trigger")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Close conversation")).toBeInTheDocument();
    // Heavy api controls never mount for PTY, but the overflow menu (export /
    // view-mode / copy transcript) still does on demand.
    fireEvent.click(screen.getByLabelText("Conversation menu"));
    expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
    expect(screen.getByTestId("overflow-menu")).toBeInTheDocument();
    // No model/context reveal row for PTY — there is nothing to reveal.
    expect(
      screen.queryByLabelText("Show model & context controls"),
    ).not.toBeInTheDocument();
  });
});
