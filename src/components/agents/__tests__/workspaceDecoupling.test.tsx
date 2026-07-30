import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContinueInMenu } from "@/components/agents/ContinueInMenu";
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

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  const now = new Date("2026-05-09T12:00:00Z").getTime();

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
        content: "Check workspace decoupling",
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

describe("Agents pane workspace decoupling", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
    useAgentSidebarPrefsStore.setState({ prefs: {} });
    agentStore.state.conversations = [
      conversation(),
      conversation({
        id: "conv-ssh",
        title: "Remote session",
        projectPath: "/srv/app",
        sshTarget: {
          id: "server-1",
          name: "Staging",
          host: "example.com",
          user: "ian",
          remotePath: "/srv/app",
        },
      }),
      conversation({
        id: "conv-worktree",
        title: "Attempt worktree",
        projectPath: "D:\\projects\\PacketADE\\.pkt-worktrees\\attempt-1",
      }),
    ];
    agentStore.state.deleteConversation = vi.fn();
    agentStore.state.archiveConversation = vi.fn();
    agentStore.state.unarchiveConversation = vi.fn();
    agentStore.state.projectLabels = {};
    agentStore.state.setProjectLabel = vi.fn();
  });

  it("offers project and execution handoffs without Workspace conversation attachment", () => {
    // ContinueInMenu is now a section component (P1-10) — no Dropdown/trigger
    // of its own, so it renders its content bare with no click needed.
    render(<ContinueInMenu conversation={conversation()} onFeedback={vi.fn()} />);

    expect(screen.getByText("Open project folder in OS")).toBeInTheDocument();
    expect(screen.getByText("Open project in Workspace")).toBeInTheDocument();
    expect(screen.queryByText("Open alongside Workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Attach terminal")).toBeInTheDocument();
    expect(screen.getByText("Continue in PacketCode…")).toBeInTheDocument();
    expect(screen.getByText("Open Git ending")).toBeInTheDocument();
    expect(screen.getByText("Add to Flight…")).toBeInTheDocument();
    expect(screen.getByText("Continue in CLI")).toBeInTheDocument();
    expect(screen.getByText("No local CLI handoff for this provider")).toBeInTheDocument();
    expect(screen.getByText("Open in VS Code")).toBeInTheDocument();
    expect(screen.getByText("Open in Cursor")).toBeInTheDocument();
    expect(screen.queryByText("Continue in CLI (claude)")).not.toBeInTheDocument();
  });

  it("copies the conversation's actual CLI command when a handoff is known", async () => {
    const onFeedback = vi.fn();
    render(
      <ContinueInMenu
        conversation={conversation({ agent: "codex", mode: "pty", model: undefined })}
        onFeedback={onFeedback}
      />,
    );

    fireEvent.click(screen.getByText("Continue in CLI (Codex)"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'cd "D:\\projects\\PacketADE" && codex',
      );
    });
    expect(onFeedback).toHaveBeenCalledWith("Command copied - paste into your terminal");
  });
});
