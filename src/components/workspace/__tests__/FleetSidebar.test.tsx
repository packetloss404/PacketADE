/**
 * Tile program (P4-S2) — FleetSidebar integration.
 *
 * Renders the real component against real stores (tauri/env mocked) to prove:
 *   - Workspace lists Workspace rows, not unplaced Agents conversations;
 *   - existing compatibility conversation panes still render inside their
 *     owning Workspace row;
 *   - a needs-you click focuses+flashes the offending pane (focusPaneRequest);
 *   - search filters the list;
 *   - per-slice subscriptions: an unrelated store update does NOT re-render.
 */
import { Profiler, act } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  // The expanded row's FILES subtree lists the project directory.
  listDirectory: vi.fn().mockResolvedValue([
    { name: "src", path: "/proj/src", is_dir: true, size: 0, extension: null },
    { name: "README.md", path: "/proj/README.md", is_dir: false, size: 12, extension: "md" },
  ]),
}));

import { FleetSidebar } from "@/components/workspace/FleetSidebar";
import { ToastProvider } from "@/components/ui/Toast";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import { useLayoutStore } from "@/stores/layoutStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace } from "@/types/workspace";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-A",
    title: "Legacy Task A",
    agent: "api-claude",
    projectPath: "/proj",
    status: "idle",
    messages: [],
    sessionId: "conv-A",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 10,
    mode: "api",
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-A",
    name: "Workspace A",
    agents: [],
    panes: [],
    projectPath: "/proj",
    createdAt: 1,
    updatedAt: 10,
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    zoomedPaneId: null,
    focusPaneRequest: null,
  });
  useFlightStore.setState({ flights: [] });
  useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
  useAgentPlanStore.setState({ plan: new Map(), planApproved: new Map() });
  useAgentSidebarPrefsStore.setState({ prefs: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("FleetSidebar", () => {
  it("does not show an unplaced conversation as a Workspace row", () => {
    useAgentTaskStore.setState({ conversations: [conv()] });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    expect(screen.queryByText("Legacy Task A")).not.toBeInTheDocument();
    expect(screen.getByText("No workspaces yet")).toBeInTheDocument();
  });

  it("offers exactly ONE create control, and it creates a real workspace", async () => {
    // The sidebar used to ship a header "+" AND a footer CTA bound to the
    // identical handler inside one 240px column. Only the labelled footer CTA
    // survives.
    useLayoutStore.setState({ projectPath: "/proj", fallbackProjectPath: "/proj" });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    const creators = screen.getAllByRole("button", { name: /new workspace/i });
    expect(creators).toHaveLength(1);

    await act(async () => {
      fireEvent.click(creators[0]);
    });

    const created = useWorkspaceStore.getState().workspaces;
    expect(created).toHaveLength(1);
    // Auto-named under the one noun, and never path-less.
    expect(created[0].name).toBe("Workspace");
    expect(created[0].projectPath).toBe("/proj");
  });

  it("keeps an existing conversation pane visible in its Workspace row", () => {
    useAgentTaskStore.setState({ conversations: [conv()] });
    useWorkspaceStore.setState({
      workspaces: [
        workspace({
          id: "ws-placed",
          name: "Agent plus terminal",
          panes: [
            {
              id: "pane-conv",
              agentId: "terminal",
              sessionId: null,
              kind: "conversation",
              conversationId: "conv-A",
            },
          ],
        }),
      ],
    });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    act(() => {
      fireEvent.click(screen.getByText("Agent plus terminal"));
    });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-placed");
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
  });

  it("needs-you click focuses+flashes the offending pane (no auto-zoom)", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-N", title: "Waiting" })] });
    useWorkspaceStore.setState({
      workspaces: [
        workspace({
          id: "ws-needs",
          name: "Waiting workspace",
          panes: [
            {
              id: "pane-needs",
              agentId: "terminal",
              sessionId: null,
              kind: "conversation",
              conversationId: "conv-N",
            },
          ],
        }),
      ],
    });
    // A pending permission ⇒ attention needs_you via sessionStatus.
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-N", [{ id: "p", tool: "bash", input: {} } as never]]]),
      edits: new Map(),
    });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    // Rendered under the Needs you group.
    expect(screen.getByText("Needs you")).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByText("Waiting workspace"));
    });

    const focus = useWorkspaceStore.getState().focusPaneRequest;
    expect(focus).not.toBeNull();
    expect(focus?.workspaceId).toBe("ws-needs");
    expect(focus?.paneId).toBe("pane-needs");
    // Focus+flash only — zoom untouched.
    expect(useWorkspaceStore.getState().zoomedPaneId).toBeNull();
  });

  it("search filters rows by title", () => {
    useWorkspaceStore.setState({
      workspaces: [
        workspace({ id: "ws-parser", name: "Refactor parser" }),
        workspace({ id: "ws-docs", name: "Write docs" }),
      ],
    });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByRole("button", { name: /search workspaces/i }));
    const input = screen.getByPlaceholderText("Search messages, titles…");
    act(() => {
      fireEvent.change(input, { target: { value: "parser" } });
    });

    expect(screen.getByText("Refactor parser")).toBeInTheDocument();
    expect(screen.queryByText("Write docs")).not.toBeInTheDocument();
  });

  it('calls a workspace a Workspace in its delete dialog, which used to say "Delete session?"', () => {
    useWorkspaceStore.setState({ workspaces: [workspace({ name: "Refactor parser" })] });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByText("Delete workspace?")).toBeInTheDocument();
    expect(screen.queryByText(/Delete session\?/)).not.toBeInTheDocument();
    // A workspace owns no worktree — deleting it detaches conversations.
    expect(
      screen.getByText(/Member conversations are detached, not destroyed/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deletes nothing until the confirm button is clicked", () => {
    useWorkspaceStore.setState({ workspaces: [workspace({ name: "Refactor parser" })] });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
    expect(screen.queryByText("Delete workspace?")).not.toBeInTheDocument();
  });

  // ── Expandable rows ──

  it("collapses by default and reveals session children + FILES on expand", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        workspace({
          name: "Browsable",
          agents: ["claude-code"],
          panes: [{ id: "pane-1", agentId: "claude-code", sessionId: "s1" }],
        }),
      ],
    });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    // Collapsed: the pane child row is not in the tree at all.
    expect(screen.queryByRole("button", { name: "Close Claude" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expand Browsable" }));
    });

    expect(screen.getByRole("button", { name: "Claude" })).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    // The flag is persisted so the tree survives a view switch.
    expect(useAgentSidebarPrefsStore.getState().prefs["ws-A"]?.expanded).toBe(true);
  });

  it("closing a terminal child kills its PTY before dropping the pane", async () => {
    const { killPty } = await import("@/lib/tauri");
    useWorkspaceStore.setState({
      workspaces: [
        workspace({
          name: "Browsable",
          agents: ["terminal"],
          panes: [{ id: "pane-1", agentId: "terminal", sessionId: "pty-9" }],
        }),
      ],
    });
    useAgentSidebarPrefsStore.setState({ prefs: { "ws-A": { expanded: true } } });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));
    });

    expect(killPty).toHaveBeenCalledWith("pty-9");
    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(0);
  });

  it("opens a file from the tree as a viewer tile in that workspace", async () => {
    useWorkspaceStore.setState({ workspaces: [workspace({ name: "Browsable" })] });
    useAgentSidebarPrefsStore.setState({ prefs: { "ws-A": { expanded: true } } });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    // Resolve the listing BEFORE entering act — awaiting a findBy* inside an
    // async act callback deadlocks: act holds the re-render the query waits on.
    const fileRow = await screen.findByText("README.md");
    await act(async () => {
      fireEvent.click(fileRow);
    });

    const [pane] = useWorkspaceStore.getState().workspaces[0].panes;
    expect(pane.kind).toBe("file");
    expect(pane.filePath).toBe("/proj/README.md");
    expect(useWorkspaceStore.getState().focusPaneRequest?.paneId).toBe(pane.id);
  });

  it("pinning an expanded row keeps it expanded", () => {
    useWorkspaceStore.setState({ workspaces: [workspace({ name: "Browsable" })] });
    useAgentSidebarPrefsStore.setState({ prefs: { "ws-A": { expanded: true } } });
    render(<FleetSidebar />, { wrapper: ToastProvider });

    fireEvent.click(screen.getByRole("button", { name: "Pin to top" }));

    const entry = useAgentSidebarPrefsStore.getState().prefs["ws-A"];
    expect(entry?.pinned).toBe(true);
    expect(entry?.expanded).toBe(true);
  });

  it("does not re-render on an unrelated store update (per-slice subscriptions)", () => {
    useWorkspaceStore.setState({
      workspaces: [workspace({ name: "Stable workspace" })],
    });
    let commits = 0;
    const onRender = () => {
      commits += 1;
    };
    render(
      <ToastProvider>
        <Profiler id="fleet" onRender={onRender}>
          <FleetSidebar />
        </Profiler>
      </ToastProvider>,
    );
    const baseline = commits;

    // layoutStore is NOT a FleetSidebar subscription — updating it must not
    // re-render the sidebar.
    act(() => {
      useLayoutStore.getState().setProjectPath("/some/other/path");
    });

    expect(commits).toBe(baseline);
  });
});
