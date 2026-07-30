import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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
  },
}));

vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: (selector: (state: typeof agentStore.state) => unknown) =>
    selector(agentStore.state),
}));

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
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
        content: "Check the Agents route",
        timestamp: 1,
      },
    ],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 10,
    mode: "api",
    provider: "openai",
    model: "gpt-5",
    ...overrides,
  };
}

describe("AgentSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentStore.state.conversations = [conversation()];
    useAgentApprovalStore.setState({
      permissions: new Map(),
      edits: new Map(),
    });
    useAgentSidebarPrefsStore.setState({
      prefs: {},
      projectLabels: {},
    });
  });

  it("selects an Agent conversation without requiring a Workspace row", () => {
    const onSelect = vi.fn();
    render(<AgentSidebar selectedId={null} onSelect={onSelect} onNewAgent={vi.fn()} />);

    fireEvent.click(screen.getByText("Investigate agent pane"));

    expect(onSelect).toHaveBeenCalledWith("conv-1");
    expect(screen.getByText("PacketADE")).toBeInTheDocument();
  });

  it("offers a first-class New agent action", () => {
    const onNewAgent = vi.fn();
    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={onNewAgent} />);

    fireEvent.click(screen.getAllByRole("button", { name: /new agent/i })[0]);

    expect(onNewAgent).toHaveBeenCalledTimes(1);
  });

  it("pulls pending approvals into a Needs you section", () => {
    act(() => {
      useAgentApprovalStore.getState().addPendingPermission("conv-1", {
        id: "perm-1",
        name: "bash",
        arguments: "{}",
      });
    });

    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("Investigate agent pane")).toBeInTheDocument();
  });

  it("sorts pinned conversations ahead of newer unpinned conversations", () => {
    agentStore.state.conversations = [
      conversation({ id: "old", title: "Older pinned", updatedAt: 1 }),
      conversation({ id: "new", title: "Newer unpinned", updatedAt: 2 }),
    ];
    useAgentSidebarPrefsStore.setState({
      prefs: { old: { pinned: true } },
    });

    render(<AgentSidebar selectedId={null} onSelect={vi.fn()} onNewAgent={vi.fn()} />);

    const titles = screen
      .getAllByText(/Older pinned|Newer unpinned/)
      .map((element) => element.textContent);
    expect(titles).toEqual(["Older pinned", "Newer unpinned"]);
  });
});
