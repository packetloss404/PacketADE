/**
 * TileHeaderActions — Memory-row REACHABILITY in the tile frame.
 *
 * The sibling TileHeaderActions.test.tsx stubs HeaderOverflowMenu to isolate
 * the lazy-mount decision, and the only test that exercises the real Memory
 * toggle row (HeaderActions.test.tsx) drives the production-DEAD standalone
 * header. Nothing proved the row is actually reachable through the tile
 * frame's chrome. This suite renders the REAL HeaderOverflowMenu, opens the
 * tile overflow cluster, opens the overflow dropdown, and toggles the Memory
 * row — the path a real user takes in the conversation tile.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";

// --- Stateful agentTaskStore mock so the Memory toggle's setState updater is
//     applied and can be asserted (the row flips memoryContextEnabled). ---
const mocks = vi.hoisted(() => {
  const agentTaskState = {
    conversations: [] as Array<{ id: string; memoryContextEnabled?: boolean; updatedAt?: number }>,
  };
  return {
    agentTaskState,
    setState: vi.fn((updater: unknown) => {
      const next =
        typeof updater === "function"
          ? (updater as (s: typeof agentTaskState) => Partial<typeof agentTaskState>)(agentTaskState)
          : (updater as Partial<typeof agentTaskState>);
      Object.assign(agentTaskState, next);
    }),
  };
});
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: Object.assign(
    vi.fn((selector: (s: typeof mocks.agentTaskState) => unknown) => selector(mocks.agentTaskState)),
    { setState: mocks.setState, getState: () => mocks.agentTaskState },
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

// memoryStore's module-level tauri imports must resolve against a stub.
vi.mock("@/lib/tauri", () => ({
  saveMemorySlice: vi.fn(),
  summarizeSession: vi.fn(),
  extractPatterns: vi.fn(),
  readPtyTranscript: vi.fn(),
  togglePinnedPattern: vi.fn(),
}));

// --- agentSettingsStore (view-mode row in the same menu). ---
vi.mock("@/stores/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ transcriptViewMode: "normal", setTranscriptViewMode: vi.fn() }),
}));

// --- Controllable workspaceStore mock (zoom gate). ---
const wsState = vi.hoisted(() => ({
  zoomedPaneId: null as string | null,
  workspaces: [] as Array<{ panes: Array<{ id: string; kind?: string; conversationId?: string }> }>,
}));
vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: (selector: (s: typeof wsState) => unknown) => selector(wsState),
}));

// --- Heavy api controls → leaf stubs; Continue-in section → stub. ---
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
vi.mock("@/components/agents/ContinueInMenu", () => ({
  ContinueInMenu: () => <div data-testid="continue-in" />,
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

function renderTile(over: Partial<AgentConversation> = {}) {
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
    />,
  );
}

/** Open the header's single overflow menu (one click: the placeholder mounts
 * HeaderOverflowMenu already open). */
function openOverflowDropdown() {
  fireEvent.click(screen.getByLabelText("Conversation menu"));
}

beforeEach(() => {
  wsState.zoomedPaneId = null;
  wsState.workspaces = [];
  mocks.agentTaskState.conversations = [{ id: "conv-1", memoryContextEnabled: false }];
  mocks.setState.mockClear();
});

describe("TileHeaderActions — Memory row reachability", () => {
  it("the Memory row is reachable via the tile overflow cluster and its dropdown", () => {
    renderTile({ memoryContextEnabled: false });

    // Row is not in the DOM until the menu mounts and opens.
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();

    openOverflowDropdown();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("toggling the Memory row flips memoryContextEnabled for this conversation", () => {
    renderTile({ memoryContextEnabled: false });
    openOverflowDropdown();

    const memoryButton = screen.getByText("Memory").closest("button");
    expect(memoryButton).toBeTruthy();
    expect(memoryButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(memoryButton!);

    expect(mocks.setState).toHaveBeenCalledTimes(1);
    expect(mocks.agentTaskState.conversations[0].memoryContextEnabled).toBe(true);
  });
});
