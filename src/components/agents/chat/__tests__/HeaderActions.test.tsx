/**
 * HeaderActions — the P1-10 chat header consolidation. Covers the resting
 * right cluster shrinking to six controls (AgentModeChip, model picker,
 * ContextUsageRing, Changes chip, overflow, close), model appearing exactly
 * once, the overflow menu's contents, PTY mode dropping the api-only
 * controls, and that the relocated MCP popover is gone.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeaderActions } from "@/components/agents/chat/HeaderActions";
import type { AgentConversation } from "@/types/agent-conversation";

const mocks = vi.hoisted(() => ({
  agentTaskState: {
    conversations: [] as unknown[],
  },
}));

vi.mock("@/stores/agentTaskStore", () => {
  const useAgentTaskStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.agentTaskState) => unknown) =>
      selector(mocks.agentTaskState),
    ),
    {
      setState: vi.fn(),
      getState: vi.fn(() => mocks.agentTaskState),
    },
  );
  return { useAgentTaskStore };
});

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: vi.fn(
    (selector: (state: { getContextForSession: () => string }) => unknown) =>
      selector({ getContextForSession: () => "" }),
  ),
}));

vi.mock("@/stores/reviewStore", () => ({
  useReviewStore: vi.fn(
    (selector: (state: { openForConversation: () => void }) => unknown) =>
      selector({ openForConversation: vi.fn() }),
  ),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  listOllamaModels: vi.fn(() => Promise.resolve([])),
}));

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Chat test",
    agent: "api-openai",
    projectPath: "/repo",
    status: "idle",
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        content: "done",
        timestamp: 1,
        inputTokens: 500,
        outputTokens: 200,
      },
    ],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    provider: "openai",
    model: "gpt-5.5",
    ...overrides,
  };
}

function renderHeader(overrides: Partial<AgentConversation> = {}) {
  const conv = conversation(overrides);
  render(
    <HeaderActions
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
    />,
  );
  return conv;
}

describe("HeaderActions", () => {
  it("renders the six resting controls for an api conversation, with the model appearing exactly once", () => {
    renderHeader();

    // AgentModeChip (default label is "Default" for auto permissionMode).
    expect(screen.getByText("Default")).toBeInTheDocument();
    // Model picker (composer ModelSelector trigger label).
    expect(screen.getAllByText("GPT-5.5 (default)")).toHaveLength(1);
    // ContextUsageRing (renders a percentage once tokens are present).
    expect(screen.getByRole("img", { name: /Context usage/i })).toBeInTheDocument();
    // Changes chip (DiffPaneTrigger).
    expect(screen.getByTitle("View 2 file changes")).toBeInTheDocument();
    // Overflow trigger + close.
    expect(screen.getByLabelText("Back to list")).toBeInTheDocument();
  });

  it("opening the overflow menu shows export, transcript density, memory, preview toggle, and Continue-in items", () => {
    renderHeader();

    const triggers = screen.getAllByRole("button");
    // The overflow trigger is the MoreVertical icon button — find it by its
    // parent not having an accessible name (unlike "Back to list").
    const overflowTrigger = triggers.find(
      (b) => !b.getAttribute("aria-label") && !b.textContent?.trim(),
    );
    expect(overflowTrigger).toBeTruthy();
    fireEvent.click(overflowTrigger!);

    expect(screen.getByText("Export as Markdown")).toBeInTheDocument();
    expect(screen.getByText("Export as JSON")).toBeInTheDocument();
    expect(screen.getByText("Copy transcript")).toBeInTheDocument();
    expect(screen.getByText("View mode")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("Show preview pane")).toBeInTheDocument();
    expect(screen.getByText("Open project folder in OS")).toBeInTheDocument();
    expect(screen.getByText("Open in VS Code")).toBeInTheDocument();
    expect(screen.getByText("Open in Cursor")).toBeInTheDocument();
  });

  it("renders only the overflow menu and close button for a PTY conversation", () => {
    renderHeader({ mode: "pty", agent: "claude-code", model: undefined, provider: undefined });

    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Context usage/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/View \d+ file/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Back to list")).toBeInTheDocument();
  });

  it("never shows the relocated MCP popover", () => {
    renderHeader();
    expect(screen.queryByText(/MCP/i)).not.toBeInTheDocument();

    const triggers = screen.getAllByRole("button");
    const overflowTrigger = triggers.find(
      (b) => !b.getAttribute("aria-label") && !b.textContent?.trim(),
    );
    fireEvent.click(overflowTrigger!);
    expect(screen.queryByText(/MCP/i)).not.toBeInTheDocument();
  });
});
