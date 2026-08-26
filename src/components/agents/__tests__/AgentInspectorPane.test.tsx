/**
 * AgentInspectorPane — behavior tests for the Agents-surface `RightDock` host.
 *
 * D2 moved the pane's five tabs (plus the D5 Editor) onto the shared dock, so
 * these tests now cover: panel switching, one-panel-at-a-time, collapse/expand,
 * the shared resizer's viewport-aware clamping and per-surface persistence,
 * auto-reveal of Preview when a target lands for THIS conversation, the Diff
 * panel's empty-state for PTY conversations, and the SSH guards (D3).
 *
 * B4 (wave 2b) changed two things these tests pin:
 *   - the dock now ships CLOSED (two-pane Agents view), so a test that wants a
 *     panel body has to open it, exactly as a user or a deep link would;
 *   - six panels became three — Inspector folded into the Diff panel's header,
 *     Files into the Editor, and the duplicate Plan panel is gone.
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

const DOCK_STORAGE_KEY = "packetbench:right-dock-v1";

function makeConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const now = new Date("2026-05-17T12:00:00Z").getTime();
  return {
    id: "conv-1",
    title: "Inspector pane test",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketBench",
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

/** Open the dock the way a user or a deep link would. B4 ships it closed. */
function openDock() {
  act(() => {
    useRightDockStore.getState().setExpanded("agents", true);
  });
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

  it("renders no dock chrome at all until something opens it (B4 two-pane default)", () => {
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);

    // Not merely collapsed to the icon rail — absent. The Agents view is two
    // panes until the dock is asked for.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("shows exactly one panel at a time as each tab is clicked", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);
    openDock();

    // Preview leads the three-panel strip now that Inspector and Files have
    // been folded into Diff and Editor.
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^diff$/i }));
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^editor$/i }));
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();
    // No buffer open → the Editor panel IS the (folded-in) file browser. No
    // SSH target on the default fixture, so AgentFilePane takes its local
    // branch rather than the "not supported" one.
    expect(
      screen.queryByText(/file browsing on ssh targets is not yet supported/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /^preview$/i }));
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
  });

  it("folds the old Inspector tab into the Diff panel's header", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);
    openDock();
    fireEvent.click(screen.getByRole("tab", { name: /^diff$/i }));

    // There is no Inspector tab any more…
    expect(screen.queryByRole("tab", { name: /^inspector$/i })).not.toBeInTheDocument();
    // …and the diffs, not the metadata, are what the panel opens on.
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();
    expect(screen.queryByText("Files changed")).not.toBeInTheDocument();

    // The metadata is one disclosure away, alongside the diffs it describes.
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    expect(screen.getByText("Files changed")).toBeInTheDocument();
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();
  });

  it("collapses to an icon strip and expands back via the chevron", () => {
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);
    openDock();

    expect(container.querySelector("aside")).not.toBeNull();
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show right pane" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Collapse pane"));

    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByRole("button", { name: "Show right pane" })).toBeInTheDocument();
    expect(screen.queryByTitle("Collapse pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    // Icon-strip buttons keep their accessible names. Three panels now, not
    // six: Inspector folded into Diff, Files into Editor, Plan is inline only.
    expect(screen.getByRole("tab", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Diff" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Show right pane" }));
    expect(container.querySelector("aside")).not.toBeNull();
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
  });

  it("clamps drag-resize to the viewport width contract and persists per surface", async () => {
    const { unmount } = render(<AgentInspectorPane conversationId="conv-1" />);
    openDock();
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

  it("auto-reveals Preview from a CLOSED dock when a target lands for this conversation", () => {
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);

    // The dock ships closed (B4), so this deep link has to do BOTH jobs:
    // pick the panel AND expand the dock. `openPanel` implying `expanded` is
    // what keeps it from being a silent no-op.
    expect(container).toBeEmptyDOMElement();

    act(() => {
      usePreviewPaneStore.getState().openPlan("conv-1", "# plan body");
    });

    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();

    // …and it works just as well from a merely-collapsed dock.
    fireEvent.click(screen.getByTitle("Collapse pane"));
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    act(() => {
      usePreviewPaneStore.getState().openMarkdown("conv-1", "README.md");
    });
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
  });

  it("ignores a preview target that belongs to a different conversation (P0-3)", () => {
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);

    act(() => {
      usePreviewPaneStore.getState().openMarkdown("conv-OTHER", "README.md");
    });

    // Conversation A's dock must not be hijacked by conversation B's preview —
    // and with the two-pane default that means it must not open at all.
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the Diff empty-state for PTY-mode conversations", () => {
    agentStore.state.conversations = [
      makeConversation({ id: "conv-pty", mode: "pty", agent: "claude-code" }),
    ];
    render(<AgentInspectorPane conversationId="conv-pty" />);
    openDock();

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
    openDock();

    for (const name of [/^preview$/i, /^editor$/i]) {
      const tab = screen.getByRole("tab", { name });
      // Discoverable, not hidden: still rendered, disabled, and explains why.
      expect(tab).toBeInTheDocument();
      expect(tab).toBeDisabled();
      expect(tab.getAttribute("title")).toMatch(/not yet available for ssh workspaces/i);
      fireEvent.click(tab);
    }
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    // Diff is the only panel an SSH conversation can select, so that is where
    // the dock lands rather than on a panel that cannot work.
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();

    // A plan landing in the preview store must not force the dock onto a
    // panel that cannot work for this conversation.
    act(() => {
      usePreviewPaneStore.getState().openPlan("conv-ssh", "# plan body");
    });
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();
  });

  it("keeps the folded-in file browser unreachable on SSH, and says why (D3)", () => {
    // The Files tab used to exist purely to tell SSH users "file browsing on
    // SSH targets is not yet supported". Now that the browser lives inside the
    // Editor panel, that same refusal is carried by the Editor tab's disabled
    // reason — one statement of the limit instead of two, and no dead tab.
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
    openDock();

    expect(screen.queryByRole("tab", { name: /^files$/i })).not.toBeInTheDocument();

    const editorTab = screen.getByRole("tab", { name: /^editor$/i });
    expect(editorTab).toBeDisabled();
    expect(editorTab.getAttribute("title")).toMatch(/not yet available for ssh workspaces/i);

    fireEvent.click(editorTab);
    expect(screen.queryByRole("button", { name: /browse files/i })).not.toBeInTheDocument();
  });
});
