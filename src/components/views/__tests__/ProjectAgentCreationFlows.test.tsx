import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Idea } from "@/types/ideation";

const mocks = vi.hoisted(() => {
  const layoutState = {
    projectPath: "D:\\projects\\layout-project",
  };
  const activeWorkspace = {
    id: "workspace-active",
    name: "Active workspace",
    agents: [],
    panes: [],
    projectPath: "D:\\projects\\active-workspace",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  };
  const workspaceState = {
    activeWorkspaceId: activeWorkspace.id,
    workspaces: [activeWorkspace],
    getActiveWorkspace: vi.fn(() => activeWorkspace),
  };
  const agentTaskState = {
    launchTask: vi.fn(),
    createApiConversation: vi.fn(),
    selectConversation: vi.fn(),
  };
  const appState = {
    setActiveView: vi.fn(),
  };
  const ideationState = {
    dismiss: vi.fn(),
    convertToIssue: vi.fn(),
    selectIdea: vi.fn(),
  };

  return {
    activeWorkspace,
    appState,
    agentTaskState,
    ideationState,
    layoutState,
    workspaceState,
  };
});

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: vi.fn((selector: (state: typeof mocks.layoutState) => unknown) =>
    selector(mocks.layoutState),
  ),
}));

vi.mock("@/stores/agentStore", () => ({
  useAgentStore: vi.fn(
    (selector: (state: { agents: Array<{ id: string; installed: boolean }> }) => unknown) =>
      selector({
        agents: [
          { id: "claude-code", installed: true },
          { id: "codex", installed: true },
          { id: "gemini", installed: true },
          { id: "opencode", installed: true },
        ],
      }),
  ),
}));

vi.mock("@/stores/agentTaskStore", () => {
  const useAgentTaskStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.agentTaskState) => unknown) =>
      selector(mocks.agentTaskState),
    ),
    {
      getState: vi.fn(() => mocks.agentTaskState),
    },
  );
  return { useAgentTaskStore };
});

vi.mock("@/stores/workspaceStore", () => {
  const useWorkspaceStore = Object.assign(
    vi.fn((selector: (state: typeof mocks.workspaceState) => unknown) =>
      selector(mocks.workspaceState),
    ),
    {
      getState: vi.fn(() => mocks.workspaceState),
    },
  );
  return { useWorkspaceStore };
});

vi.mock("@/stores/appStore", () => ({
  useAppStore: {
    getState: vi.fn(() => mocks.appState),
  },
}));

vi.mock("@/stores/ideationStore", () => ({
  useIdeationStore: vi.fn((selector: (state: typeof mocks.ideationState) => unknown) =>
    selector(mocks.ideationState),
  ),
}));

import { NewAgentTaskModal } from "@/components/agents/NewAgentTaskModal";
import { IdeaCard } from "@/components/views/ideation/IdeaCard";
import { IdeaDetail } from "@/components/views/ideation/IdeaDetail";

function makeIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: "idea-1",
    type: "code_quality",
    title: "Extract parser helper",
    description: "The parsing branch has grown repetitive.",
    severity: "medium",
    affectedFiles: ["src/parser.ts"],
    suggestion: "Extract the shared parsing logic.",
    effort: "small",
    status: "active",
    ...overrides,
  };
}

describe("project-based agent creation flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentTaskState.launchTask.mockResolvedValue("task-1");
    mocks.agentTaskState.createApiConversation.mockResolvedValue("conversation-1");
  });

  it("launches NewAgentTaskModal tasks in the layout project path", async () => {
    const onClose = vi.fn();
    render(<NewAgentTaskModal onClose={onClose} />);

    fireEvent.change(screen.getByPlaceholderText("Short name for this task"), {
      target: { value: "Investigate parser" },
    });
    fireEvent.change(screen.getByPlaceholderText("Describe what the agent should do..."), {
      target: { value: "Find the parser duplication and suggest a cleanup." },
    });
    fireEvent.click(screen.getByText("Launch Agent"));

    await waitFor(() => expect(mocks.agentTaskState.launchTask).toHaveBeenCalledTimes(1));
    expect(mocks.agentTaskState.launchTask).toHaveBeenCalledWith(
      "Investigate parser",
      "Find the parser duplication and suggest a cleanup.",
      "claude-code",
      mocks.layoutState.projectPath,
    );
    expect(mocks.agentTaskState.launchTask).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mocks.activeWorkspace.projectPath,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks Scout from an idea card using the active workspace project path without a workspace id", async () => {
    const idea = makeIdea();
    render(<IdeaCard idea={idea} isSelected={false} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByTitle("Ask Scout (read-only agent with project memory)"));

    await waitFor(() =>
      expect(mocks.agentTaskState.createApiConversation).toHaveBeenCalledTimes(1),
    );
    const [options] = mocks.agentTaskState.createApiConversation.mock.calls[0];
    expect(options.agent).toBe("api-claude");
    expect(options.projectPath).toBe(mocks.activeWorkspace.projectPath);
    expect(Object.values(options)).not.toContain(mocks.activeWorkspace.id);
    expect(mocks.agentTaskState.selectConversation).toHaveBeenCalledWith("conversation-1");
    expect(mocks.appState.setActiveView).toHaveBeenCalledWith("agents");
  });

  it("asks Scout from idea detail using the active workspace project path without a workspace id", async () => {
    const idea = makeIdea();
    render(<IdeaDetail idea={idea} />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Scout" }));

    await waitFor(() =>
      expect(mocks.agentTaskState.createApiConversation).toHaveBeenCalledTimes(1),
    );
    const [options] = mocks.agentTaskState.createApiConversation.mock.calls[0];
    expect(options.agent).toBe("api-claude");
    expect(options.projectPath).toBe(mocks.activeWorkspace.projectPath);
    expect(Object.values(options)).not.toContain(mocks.activeWorkspace.id);
    expect(options.initialMessage).toContain("Suggestion: Extract the shared parsing logic.");
    expect(mocks.agentTaskState.selectConversation).toHaveBeenCalledWith("conversation-1");
    expect(mocks.appState.setActiveView).toHaveBeenCalledWith("agents");
  });
});
