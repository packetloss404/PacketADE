/**
 * TileHeaderActions — overflow-menu CONTENT in the tile frame (H3 migration).
 *
 * These assertions previously lived in HeaderActions.test.tsx and drove the
 * now-deleted standalone header. AgentChatPane mounts TileHeaderActions
 * directly, so the overflow-menu contents (export items, transcript density,
 * the preview toggle, the Continue-in section) and the Memory flyout (stats +
 * preview items) are exercised here through the real HeaderOverflowMenu +
 * ContinueInMenu, reached via the tile's lazy-mount cluster. Reachability +
 * the Memory toggle itself are covered by TileHeaderActions.memoryRow.test.tsx.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

// --- agentTaskStore (Memory toggle reads/writes through it). ---
const mocks = vi.hoisted(() => ({
  agentTaskState: { conversations: [] as unknown[] },
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: Object.assign(
    vi.fn((selector: (s: typeof mocks.agentTaskState) => unknown) => selector(mocks.agentTaskState)),
    { setState: vi.fn(), getState: () => mocks.agentTaskState },
  ),
}));

// --- memoryStore: real module (keeps memoryBriefStats), controllable brief. ---
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
  const actual = await vi.importActual<typeof import("@/stores/memoryStore")>("@/stores/memoryStore");
  return {
    ...actual,
    useMemoryStore: vi.fn((selector: (s: typeof memoryMocks.memoryState) => unknown) =>
      selector(memoryMocks.memoryState),
    ),
  };
});

// memoryStore's module-level tauri imports must resolve against a stub. The
// plugin-shell `open` is what the real ContinueInMenu items call.
vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  togglePinnedPattern: vi.fn(),
  listOllamaModels: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

// --- agentSettingsStore (View mode row). ---
vi.mock("@/stores/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ transcriptViewMode: "normal", setTranscriptViewMode: vi.fn() }),
}));

// --- workspaceStore zoom gate (resting: not zoomed). ---
const wsState = vi.hoisted(() => ({
  zoomedPaneId: null as string | null,
  workspaces: [] as Array<{ panes: Array<{ id: string; kind?: string; conversationId?: string }> }>,
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (s: typeof wsState) => unknown) => selector(wsState),
}));

// --- Heavy always/lazy api chips → leaf stubs so the ONLY unlabeled/untitled
//     button in the DOM is HeaderOverflowMenu's dropdown trigger. ContinueInMenu
//     is intentionally NOT stubbed — its items are asserted below. ---
vi.mock("@/components/agents/composer/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
vi.mock("@/components/agents/ContextUsageRing", () => ({
  ContextUsageRing: () => <div data-testid="context-ring" />,
}));
vi.mock("@/components/agents/AgentModeChip", () => ({
  AgentModeChip: () => <div data-testid="mode-chip" />,
}));
vi.mock("@/components/agents/DiffPaneTrigger", () => ({
  DiffPaneTrigger: () => <div data-testid="diff-trigger" />,
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
  render(
    <TileHeaderActions
      conversation={conv}
      conversationId={conv.id}
      diffTotals={{ fileCount: 2, totalAdds: 10, totalDels: 3 }}
      previewOpen={false}
      togglePreview={vi.fn()}
      onClose={vi.fn()}
      onExport={vi.fn()}
      pendingApprovalCount={0}
      {...props}
    />,
  );
  return conv;
}

/** The header has ONE menu control: clicking it mounts the overflow menu
 * already open (the placeholder hands its click straight to the dropdown). */
function openOverflowMenu() {
  fireEvent.click(screen.getByLabelText("Conversation menu"));
}

afterEach(() => {
  memoryMocks.memoryState.composeMemoryBrief.mockReturnValue({
    text: "",
    items: [],
    charBudget: 1800,
    truncated: false,
    scopeKey: "",
  });
});

describe("TileHeaderActions — overflow menu content", () => {
  it("shows export, transcript density, memory, preview toggle, and Continue-in items", () => {
    renderTile();
    openOverflowMenu();

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

  it("is the tile's ONE menu: every action from the merged menus is in it", () => {
    const onArchive = vi.fn();
    renderTile({}, { onArchive });
    openOverflowMenu();

    // The "Show model & context controls" reveal row is GONE (wave 2a): the
    // model picker and context ring it revealed moved onto the composer, so it
    // has nothing left in the header to toggle. Asserting its ABSENCE keeps a
    // dead affordance from creeping back in.
    expect(
      screen.queryByText("Show model & context controls"),
    ).not.toBeInTheDocument();
    // Merged in from the tile chrome bar's kebab (its only item).
    expect(screen.getByText("Archive conversation")).toBeInTheDocument();
    // Everything the menu already held.
    expect(screen.getByText("View mode")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("Show preview pane")).toBeInTheDocument();
    expect(screen.getByText("Send to Monitor")).toBeInTheDocument();
    expect(screen.getByText("Export as Markdown")).toBeInTheDocument();
    expect(screen.getByText("Export as JSON")).toBeInTheDocument();
    expect(screen.getByText("Copy transcript")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Archive conversation"));
    expect(onArchive).toHaveBeenCalledTimes(1);
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

    renderTile({ memoryContextEnabled: true });
    openOverflowMenu();

    expect(screen.getByText(/2 patterns · 1 lesson/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show memory preview"));
    expect(screen.getByText("Prefer named exports")).toBeInTheDocument();
  });
});
