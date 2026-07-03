import { render, screen, within } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSidebar } from "@/components/agents/AgentSidebar";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentSidebarPrefsStore } from "@/stores/agentSidebarPrefsStore";
import type { AgentConversation } from "@/types/agent-conversation";

const agentStore = vi.hoisted(() => ({
  state: {
    conversations: [] as AgentConversation[],
    deleteConversation: vi.fn(),
    archiveConversation: vi.fn(),
    unarchiveConversation: vi.fn(),
    projectLabels: {} as Record<string, string>,
    setProjectLabel: vi.fn(),
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof agentStore.state) => unknown) =>
    selector(agentStore.state),
}));

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const now = new Date("2026-07-01T12:00:00Z").getTime();

  return {
    id: "conv-1",
    title: "Investigate agent pane",
    agent: "api-openai",
    projectPath: "D:\\projects\\PacketADE",
    status: "idle",
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "Check the sidebar diet",
        timestamp: now,
      },
    ],
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

describe("AgentSidebar", () => {
  beforeEach(() => {
    useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
    useAgentSidebarPrefsStore.setState({ prefs: {} });
    agentStore.state.conversations = [conversation()];
    agentStore.state.deleteConversation = vi.fn();
    agentStore.state.archiveConversation = vi.fn();
    agentStore.state.unarchiveConversation = vi.fn();
    agentStore.state.projectLabels = {};
    agentStore.state.setProjectLabel = vi.fn();
  });

  it("renders no group/sort configurators or tag button", () => {
    render(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /group:/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sort/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Add tag")).not.toBeInTheDocument();
  });

  it("renders status, title, and agent for a row but not cost, turns, or model", () => {
    render(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText("Investigate agent pane")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText(/gpt-5/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/turn/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("shows a NEEDS YOU section with an amber header count badge when a pending permission exists", () => {
    act(() => {
      useAgentApprovalStore.getState().addPendingPermission("conv-1", {
        id: "perm-1",
        name: "bash",
        arguments: "{}",
      });
    });

    render(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText("Needs you")).toBeInTheDocument();
    // Header badge next to "Sessions" count shows the needs-you count.
    const header = screen.getByText("Sessions").closest("div")!;
    const amberBadge = header.querySelector(".text-accent-amber");
    expect(amberBadge).toHaveTextContent("1");
  });

  it("shows a NEEDS YOU section for a pending edit too, and it vanishes once the queues drain", () => {
    act(() => {
      useAgentApprovalStore.getState().addPendingEdit("conv-1", {
        id: "edit-1",
        path: "src/foo.ts",
        content: "// new",
      });
    });

    const { rerender } = render(
      <AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Needs you")).toBeInTheDocument();

    act(() => {
      useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
    });
    rerender(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.queryByText("Needs you")).not.toBeInTheDocument();
  });

  it("pulls a needs-you conversation out of its project group while pending", () => {
    agentStore.state.conversations = [
      conversation({ id: "conv-1", title: "Needs a decision" }),
      conversation({ id: "conv-2", title: "Quiet session" }),
    ];
    act(() => {
      useAgentApprovalStore.getState().addPendingPermission("conv-1", {
        id: "perm-1",
        name: "bash",
        arguments: "{}",
      });
    });

    render(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);

    const needsYouHeader = screen.getByText("Needs you").closest("div")!.parentElement!;
    expect(within(needsYouHeader).getByText("Needs a decision")).toBeInTheDocument();

    // The project group header ("PacketADE") still exists, but only the
    // quiet session sits under it.
    const projectHeader = screen.getByText("PacketADE").closest("div")!.parentElement!;
    expect(within(projectHeader).getByText("Quiet session")).toBeInTheDocument();
    expect(within(projectHeader).queryByText("Needs a decision")).not.toBeInTheDocument();
  });

  it("never shows a NEEDS YOU section on the Archived filter tab", () => {
    agentStore.state.conversations = [
      conversation({ id: "conv-1", title: "Archived but pending?", archived: true }),
    ];
    act(() => {
      useAgentApprovalStore.getState().addPendingPermission("conv-1", {
        id: "perm-1",
        name: "bash",
        arguments: "{}",
      });
    });

    render(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);
    const filters = screen.getAllByRole("button", { name: /^archived/i });
    filters[0].click();

    expect(screen.queryByText("Needs you")).not.toBeInTheDocument();
  });

  it("sorts a pinned conversation above an unpinned one within the same project group", () => {
    agentStore.state.conversations = [
      conversation({ id: "conv-old", title: "Older, pinned", updatedAt: 1 }),
      conversation({ id: "conv-new", title: "Newer, unpinned", updatedAt: 2 }),
    ];
    useAgentSidebarPrefsStore.setState({ prefs: { "conv-old": { pinned: true } } });

    render(<AgentSidebar onNewAgent={vi.fn()} selectedId={null} onSelect={vi.fn()} />);

    const titles = screen.getAllByText(/Older, pinned|Newer, unpinned/).map((el) => el.textContent);
    expect(titles.indexOf("Older, pinned")).toBeLessThan(titles.indexOf("Newer, unpinned"));
  });
});
