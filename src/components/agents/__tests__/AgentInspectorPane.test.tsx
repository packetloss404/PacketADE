/**
 * AgentInspectorPane — behavior tests for the consolidated four-tab pane.
 *
 * Covers: tab switching, collapse/expand, resize-handle clamping and
 * persistence, auto-switch to Preview when the preview store flips, the
 * Diff tab's empty-state for PTY conversations, and the Files tab's SSH
 * guard. Child panes (AgentPreviewPane, EmbeddedDiffPane) are stubbed
 * with test-id sentinels; AgentFilePane renders its real SSH branch so
 * the guard copy is verified against the live component.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "@/types/agent-conversation";
import { usePreviewPaneStore } from "@/stores/previewPaneStore";

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
}));

vi.mock("@/components/agents/AgentPreviewPane", () => ({
  AgentPreviewPane: () => <div data-testid="preview-pane" />,
}));

vi.mock("@/components/agents/EmbeddedDiffPane", () => ({
  EmbeddedDiffPane: () => <div data-testid="diff-pane" />,
}));

import { AgentInspectorPane } from "@/components/agents/AgentInspectorPane";

const WIDTH_STORAGE_KEY = "packetade:agent-inspector-width-v1";

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

function resetPreviewStore() {
  usePreviewPaneStore.setState({
    open: false,
    activeTab: "markdown",
    markdownPath: null,
    planTitle: "Agent plan",
    planContent: "",
    browserUrl: "",
  });
}

describe("AgentInspectorPane", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPreviewStore();
    agentStore.state.conversations = [makeConversation()];
  });

  afterEach(() => {
    resetPreviewStore();
  });

  it("switches the rendered child when each tab button is clicked", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);

    // Inspector tab is active on first mount — its content renders the
    // "Files changed" section header.
    expect(screen.getByText("Files changed")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /preview/i }));
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
    expect(screen.queryByText("Files changed")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /diff/i }));
    expect(screen.getByTestId("diff-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /files/i }));
    // No SSH target on the default fixture → AgentFilePane mounts its
    // local-FS branch; the SSH "not supported" copy is asserted in a
    // dedicated test below. Confirm the diff stub unmounted.
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /inspector/i }));
    expect(screen.getByText("Files changed")).toBeInTheDocument();
  });

  it("collapses to an icon strip and expands back via the chevron", () => {
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);

    // Expanded: the wide tab bar is rendered as an <aside> with a width
    // style; the "Collapse pane" chevron is the right-aligned action.
    expect(container.querySelector("aside")).not.toBeNull();
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
    expect(screen.queryByTitle("Show right pane")).not.toBeInTheDocument();
    // Inspector content (only rendered when the pane is expanded AND the
    // inspector tab is active) is visible.
    expect(screen.getByText("Files changed")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Collapse pane"));

    // Collapsed: the <aside> is gone, replaced by the thin icon strip;
    // the chevron flips to "Show right pane"; inspector content is no
    // longer rendered because the body div is gone.
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByTitle("Show right pane")).toBeInTheDocument();
    expect(screen.queryByTitle("Collapse pane")).not.toBeInTheDocument();
    expect(screen.queryByText("Files changed")).not.toBeInTheDocument();
    // Icon-strip buttons (identified by title attribute) are present.
    expect(screen.getByTitle("Inspector")).toBeInTheDocument();
    expect(screen.getByTitle("Preview")).toBeInTheDocument();
    expect(screen.getByTitle("Diff")).toBeInTheDocument();
    expect(screen.getByTitle("Files")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Show right pane"));
    expect(container.querySelector("aside")).not.toBeNull();
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
  });

  it("clamps drag-resize to [280, 720] and persists the width on drag end", async () => {
    const { unmount } = render(<AgentInspectorPane conversationId="conv-1" />);
    // Let InspectorContent's async diff-aggregation effect settle so
    // its setState calls don't bleed across `act` boundaries.
    await act(async () => {});
    const handle = screen.getByRole("separator", { name: /resize right pane/i });

    // jsdom innerWidth defaults to 1024. The handler computes
    // `innerWidth - clientX`, so clientX=200 → 824 (above max 720 → clamps
    // to 720). clientX=900 → 124 (below min 280 → clamps to 280).
    expect(window.innerWidth).toBe(1024);

    // The mount-time effect persists the default width; clear it so the
    // assertions below speak only to drag-end writes.
    localStorage.removeItem(WIDTH_STORAGE_KEY);

    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 200 });
    fireEvent.pointerUp(window);
    expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBe("720");

    // Second drag — over-minimum clientX should clamp to 280.
    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 900 });
    fireEvent.pointerUp(window);
    expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBe("280");

    // Remount — persisted width is restored. Width is inline-styled on
    // the <aside> root.
    unmount();
    localStorage.setItem(WIDTH_STORAGE_KEY, "456");
    const { container } = render(<AgentInspectorPane conversationId="conv-1" />);
    await act(async () => {});
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.style.width).toBe("456px");
  });

  it("auto-switches to Preview (and re-expands) when the preview store opens", () => {
    render(<AgentInspectorPane conversationId="conv-1" />);

    // Start collapsed on Inspector to prove BOTH effects (tab switch +
    // expand) fire from a single store flip.
    fireEvent.click(screen.getByTitle("Collapse pane"));
    expect(screen.getByTitle("Show right pane")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-pane")).not.toBeInTheDocument();

    act(() => {
      usePreviewPaneStore.getState().openPlan("# plan body");
    });

    // Pane re-expanded → Collapse chevron is back; Preview tab is active.
    expect(screen.getByTitle("Collapse pane")).toBeInTheDocument();
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
  });

  it("renders the Diff empty-state for PTY-mode conversations", () => {
    agentStore.state.conversations = [
      makeConversation({ id: "conv-pty", mode: "pty", agent: "claude-code" }),
    ];
    render(<AgentInspectorPane conversationId="conv-pty" />);

    fireEvent.click(screen.getByRole("tab", { name: /diff/i }));

    // EmbeddedDiffPane is NOT mounted for pty conversations.
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();
    expect(
      screen.getByText(/diffs are only tracked for api-mode conversations/i),
    ).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("tab", { name: /files/i }));

    expect(
      screen.getByText(/file browsing on ssh targets is not yet supported/i),
    ).toBeInTheDocument();
  });
});
