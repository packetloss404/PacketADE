/**
 * AgentInspectorPane — behavior tests for the Agents-surface `RightDock` host.
 *
 * D2 moved the pane's five tabs (plus the D5 Editor) onto the shared dock, so
 * these tests now cover: panel switching, one-panel-at-a-time, collapse/expand,
 * the shared resizer's viewport-aware clamping and per-surface persistence,
 * auto-reveal of Preview when a target lands for THIS conversation, the Diff
 * panel's empty-state for PTY conversations, and the SSH guards (D3).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";
import { useRightDockStore } from "@/stores/rightDockStore";

const agentStore = vi.hoisted(() => ({
  state: {
    conversations: [] as AgentConversation[],
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof agentStore.state) => unknown) =>
    selector(agentStore.state),
}));

// Stub @/lib/tauri so InspectorContent's diff aggregation and any
// AgentFilePane wiring stay inert. Only the AgentFilePane SSH branch is
// reached in these tests, and it short-circuits before touching tauri.
vi.mock("@/lib/tauri", () => ({
  readFileForDiff: vi.fn().mockResolvedValue(""),
  listDirectory: vi.fn().mockResolvedValue({ entries: [], path: "" }),
  readFileContents: vi.fn().mockResolvedValue(""),
  writeFileContents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/components/agents/AgentPreviewPane", () => ({
  AgentPreviewPane: () => <div data-testid="preview-pane" />,
}));

vi.mock("@/components/agents/review/ReviewSurface", () => ({
  ReviewSurface: () => <div data-testid="diff-pane" />,
}));

import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";

const DOCK_STORAGE_KEY = "packetade:right-dock-v1";

function makeConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const now = new Date("2026-05-17T12:00:00Z").getTime();
  return {
    id: "conv-1",
    title: "Inspector pane test",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketADE",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: now,
    updatedAt: now,
    mode: "api",
    provider: "openai",
    model: "gpt-5",
    ...overrides,
  };
}

function persistedAgentsDock(): { width?: number; expanded?: boolean; activePanel?: string } {
  const raw = localStorage.getItem(DOCK_STORAGE_KEY);
  return raw ? JSON.parse(raw).agents : {};
}

describe("AgentInspectorPane", () => {
  beforeEach(() => {
    localStorage.clear();
    usePreviewPaneStore.getState().clear();
    useRightDockStore.getState().reset();
    agentStore.state.conversations = [makeConversation()];
  });

  afterEach(() => {
    usePreviewPaneStore.getState().clear();
  });

  it("shows exactly one panel at a time as each tab is clicked", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);

    // Inspector panel is active on first mount — its content renders the
    // "Files changed" section header.
    expect(screen.getByText("Files changed")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^preview$/i }));
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
    expect(screen.queryByText("Files changed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^diff$/i }));
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^files$/i }));
    // No SSH target on the default fixture → AgentFilePane mounts its
    // local-FS branch; confirm the diff stub unmounted.
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^editor$/i }));
    expect(screen.getByText("No file open.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^inspector$/i }));
    expect(screen.getByText("Files changed")).toBeInTheDocument();
    expect(screen.queryByText("No file open.")).not.toBeInTheDocument();
  });

  it("collapses to an icon strip and expands back via the chevron", () => {
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);

    expect(container.querySelector("aside")).not.toBeNull();
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show right pane" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Files changed")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Collapse pane"));

    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByRole("button", { name: "Show right pane" })).toBeInTheDocument();
    expect(screen.queryByTitle("Collapse pane")).not.toBeInTheDocument();
    expect(screen.queryByText("Files changed")).not.toBeInTheDocument();
    // Icon-strip buttons keep their accessible names.
    expect(screen.getByRole("tab", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Editor" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show right pane" }));
    expect(container.querySelector("aside")).not.toBeNull();
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
  });

  it("clamps drag-resize to the viewport width contract and persists per surface", async () => {
    const { unmount } = render(<AgentInspectorPane conversationId="conv-1" />);
    // Let InspectorContent's async diff-aggregation effect settle so
    // its setState calls don't bleed across `act` boundaries.
    await act(async () => {});
    const handle = screen.getByRole("separator", { name: /resize right pane/i });

    // jsdom innerWidth defaults to 1024. The handler computes
    // `innerWidth - clientX`; the store clamps to [260, 720] and the dock
    // then clamps again to the width the agents surface can actually afford
    // (1024 − 44 rail − 252 sidebar − 320 min centre = 408).
    expect(window.innerWidth).toBe(1024);

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerUp(window);
    // Stored preference honours the hard max…
    expect(persistedAgentsDock().width).toBe(720);
    // …but the rendered dock never starves the centre canvas.
    expect(document.querySelector("aside")!.getAttribute("style")).toContain("408px");

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 900 });
    fireEvent.pointerUp(window);
    expect(persistedAgentsDock().width).toBe(260);

    // Remount — persisted width is restored (and re-clamped).
    unmount();
    useRightDockStore.getState().setWidth("agents", 380);
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);
    await act(async () => {});
    expect(container.querySelector("aside")!.style.width).toBe("380px");
  });

  it("auto-reveals Preview (and re-expands) when a target lands for this conversation", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);

    // Start collapsed on Inspector to prove BOTH effects (panel switch +
    // expand) fire from a single store change.
    fireEvent.click(screen.getByTitle("Collapse pane"));
    expect(screen.getByRole("button", { name: "Show right pane" })).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    act(() => {
      usePreviewPaneStore.getState().openPlan("conv-1", "# plan body");
    });

    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
  });

  it("ignores a preview target that belongs to a different conversation (P0-3)", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);
    expect(screen.getByText("Files changed")).toBeInTheDocument();

    act(() => {
      usePreviewPaneStore.getState().openMarkdown("conv-OTHER", "README.md");
    });

    // Conversation A's dock must not be hijacked by conversation B's preview.
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    expect(screen.getByText("Files changed")).toBeInTheDocument();
  });

  it("renders the Diff empty-state for PTY-mode conversations", () => {
    agentStore.state.conversations = [
      makeConversation({ id: "conv-pty", mode: "pty", agent: "claude-code" }),
    ];
    render(<AgentInspectorPane conversationId="conv-pty" />);

    fireEvent.click(screen.getByRole("tab", { name: /^diff$/i }));

    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();
    expect(
      screen.getByText(/diffs are only tracked for api-mode conversations/i),
    ).toBeInTheDocument();
  });

  it("disables (does not hide) Preview and Editor on SSH conversations and refuses the auto-reveal (D3 / P0-4)", () => {
    agentStore.state.conversations = [
      makeConversation({
        id: "conv-ssh",
        sshTarget: {
          id: "server-1",
          name: "Staging",
          host: "example.com",
          user: "ian",
          remotePath: "/srv/app",
        },
      }),
    ];
    render(<AgentInspectorPane conversationId="conv-ssh" />);

    for (const name of [/^preview$/i, /^editor$/i]) {
      const tab = screen.getByRole("tab", { name });
      // Discoverable, not hidden: still rendered, disabled, and explains why.
      expect(tab).toBeInTheDocument();
      expect(tab).toBeDisabled();
      expect(tab.getAttribute("title")).toMatch(/not yet available for ssh workspaces/i);
      fireEvent.click(tab);
    }
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    expect(screen.queryByText("No file open.")).not.toBeInTheDocument();

    // A plan landing in the preview store must not force the dock onto a
    // panel that cannot work for this conversation.
    act(() => {
      usePreviewPaneStore.getState().openPlan("conv-ssh", "# plan body");
    });
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    expect(screen.getByText("Files changed")).toBeInTheDocument();
  });

  it("shows the SSH 'not supported' message on the Files tab for SSH conversations", () => {
    agentStore.state.conversations = [
      makeConversation({
        id: "conv-ssh",
        sshTarget: {
          id: "server-1",
          name: "Staging",
          host: "example.com",
          user: "ian",
          remotePath: "/srv/app",
        },
      }),
    ];
    render(<AgentInspectorPane conversationId="conv-ssh" />);

    fireEvent.click(screen.getByRole("tab", { name: /^files$/i }));

    expect(
      screen.getByText(/file browsing on ssh targets is not yet supported/i),
    ).toBeInTheDocument();
  });
});
