/**
 * HeaderActions — the P1-10 chat header consolidation. Covers the resting
 * right cluster shrinking to six controls (AgentModeChip, model picker,
 * ContextUsageRing, Changes chip, overflow, close), model appearing exactly
 * once, the overflow menu's contents, PTY mode dropping the api-only
 * controls, and that the relocated MCP popover is gone.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const memoryMocks = vi.hoisted(() => ({
  memoryState: {
    events: [] as unknown[],
    patterns: [] as unknown[],
    composeMemoryBrief: vi.fn(() => ({
      text: "",
      items: [] as { id: string; kind: string; title: string; timestamp: number; reason: string }[],
      charBudget: 1800,
      truncated: false,
      scopeKey: "",
    })),
  },
}));

vi.mock("@/stores/memoryStore", async () => {
  const actual =
    await vi.importActual<typeof import("@/stores/memoryStore")>(
      "@/stores/memoryStore",
    );
  return {
    ...actual,
    useMemoryStore: vi.fn(
      (selector: (state: typeof memoryMocks.memoryState) => unknown) =>
        selector(memoryMocks.memoryState),
    ),
  };
});

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
  afterEach(() => {
    memoryMocks.memoryState.composeMemoryBrief.mockReturnValue({
      text: "",
      items: [],
      charBudget: 1800,
      truncated: false,
      scopeKey: "",
    });
  });

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

  it("shows memory stats and a preview item after expanding the flyout when memory is on", () => {
    memoryMocks.memoryState.composeMemoryBrief.mockReturnValue({
      text: "## PacketADE Memory Brief\n...",
      items: [
        { id: "p1", kind: "pattern", title: "Prefer named exports", timestamp: 1, reason: "" },
        { id: "p2", kind: "pattern", title: "Run tests before commit", timestamp: 2, reason: "" },
        { id: "l1", kind: "lesson", title: "SSH deploys need host-key pinning", timestamp: 3, reason: "" },
      ],
      charBudget: 1800,
      truncated: false,
      scopeKey: "local:/repo",
    });

    renderHeader({ memoryContextEnabled: true });

    const triggers = screen.getAllByRole("button");
    const overflowTrigger = triggers.find(
      (b) => !b.getAttribute("aria-label") && !b.textContent?.trim(),
    );
    fireEvent.click(overflowTrigger!);

    expect(screen.getByText(/2 patterns · 1 lesson/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show memory preview"));
    expect(screen.getByText("Prefer named exports")).toBeInTheDocument();
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
