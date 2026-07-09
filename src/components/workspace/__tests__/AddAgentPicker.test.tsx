import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddAgentPicker } from "@/components/workspace/AddAgentPicker";
import { useDraftTileStore } from "@/stores/draftTileStore";
import type { Workspace } from "@/types/workspace";

/**
 * AddAgentPicker (P3-S4): one add flow, two labeled sections (Chat agents first,
 * then Terminals), capability language. Verifies:
 *   - search disambiguation ("cla" surfaces Claude under Chat agents AND Claude
 *     Code under Terminals — the same vendor legitimately in both sections);
 *   - a Terminal row adds a pane instantly (today's behavior, install-gated);
 *   - a Chat row drops a DRAFT tile (no conversation created — deferred to first
 *     send), recorded in draftTileStore.
 */

const addPane = vi.fn(() => "ws-pane-1");

vi.mock("@/components/agents/hooks/useProviderAuthStatus", () => ({
  useProviderAuthStatus: () => ({ authStatus: {}, refreshAuthStatuses: vi.fn() }),
}));

vi.mock("@/stores/workspaceStore", () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (s: { addPane: typeof addPane }) => unknown) => selector({ addPane })),
    { getState: () => ({ addPane }) },
  ),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: vi.fn((selector: (s: { agents: unknown[] }) => unknown) =>
    selector({
      agents: [
        { id: "claude-code", installed: true },
        { id: "codex", installed: true },
        { id: "gemini", installed: false },
        { id: "opencode", installed: false },
        { id: "packetcode", installed: false },
      ],
    }),
  ),
}));

vi.mock("@/stores/serverStore", () => ({
  useServerStore: vi.fn((selector: (s: { servers: unknown[] }) => unknown) =>
    selector({ servers: [] }),
  ),
}));

const localWorkspace: Workspace = {
  id: "ws-local",
  name: "Local",
  agents: [],
  panes: [],
  projectPath: "/tmp/project",
  createdAt: 1,
  updatedAt: 1,
  status: "active",
};

describe("AddAgentPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDraftTileStore.setState({ drafts: [] });
  });

  function openPopover() {
    render(<AddAgentPicker workspace={localWorkspace} variant="popover" />);
    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
  }

  it("renders Chat agents first, then Terminals", () => {
    openPopover();
    const chat = screen.getByText("Chat agents");
    const terminals = screen.getByText("Terminals");
    // Chat header precedes the Terminals header in document order.
    expect(chat.compareDocumentPosition(terminals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("disambiguates a search across both sections ('cla' → Claude + Claude Code)", () => {
    openPopover();
    fireEvent.change(screen.getByPlaceholderText("Search agents…"), {
      target: { value: "cla" },
    });

    // Chat agents section keeps its header and a Claude face.
    expect(screen.getByText("Chat agents")).toBeInTheDocument();
    expect(screen.getByText("Claude API")).toBeInTheDocument();

    // Terminals section keeps its header and Claude Code.
    expect(screen.getByText("Terminals")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude Code" })).toBeInTheDocument();

    // Non-matching rows are filtered out of both sections.
    expect(screen.queryByText("Ollama")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
  });

  it("adds a Terminal pane instantly on click", () => {
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(addPane).toHaveBeenCalledWith("ws-local", "claude-code");
    // No draft is created for a terminal pick.
    expect(useDraftTileStore.getState().drafts).toHaveLength(0);
  });

  it("drops a DRAFT tile for a Chat row without creating a conversation", () => {
    openPopover();
    // Click the Chat "Claude API" face (the pick button inside the row).
    const chatSection = screen.getByText("Chat agents").parentElement as HTMLElement;
    fireEvent.click(within(chatSection).getByText("Claude API"));

    const drafts = useDraftTileStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].workspaceId).toBe("ws-local");
    expect(drafts[0].agent).toBe("api-claude");
    // A chat pick never adds a real pane (the draft materializes one on send).
    expect(addPane).not.toHaveBeenCalled();
  });
});
