/**
 * WA1 conversation navigation.
 *
 * Ordinary links open Agents without mutating Workspace state. Saved Workspace
 * conversation panes remain migration-compatible, but no new attachment API
 * exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "") })),
  },
}));
vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  startApiAgentSession: vi.fn().mockResolvedValue(undefined),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn().mockResolvedValue(undefined),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn().mockResolvedValue(undefined),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: vi.fn().mockResolvedValue(undefined),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  getGitStatus: vi.fn(),
  removeConversationWorktree: vi.fn(),
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
}));

import {
  focusConversationDeepLink,
  initSessionGlue,
  openConversationInAgents,
  teardownSessionGlue,
} from "@/stores/sessionGlue";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";
import { useWorkspaceAgentsDogfoodStore } from "@/stores/workspaceAgentsDogfoodStore";

function conversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Fix bug",
    agent: "api-claude",
    projectPath: "/proj",
    status: "active",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

describe("WA1 conversation navigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentTaskStore.setState({
      conversations: [],
      selectedConversationId: null,
    });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      zoomedPaneId: null,
      focusPaneRequest: null,
    });
    useLayoutStore.setState({ activePaneId: "", projectPath: "" });
    useAppStore.setState({ activeView: "welcome" });
    useWorkspaceAgentsDogfoodStore.getState().reset();
  });

  afterEach(() => {
    teardownSessionGlue();
    vi.useRealTimers();
  });

  it("opens an existing conversation in Agents without creating a Workspace", () => {
    useAgentTaskStore.setState({
      conversations: [conversation()],
      selectedConversationId: null,
    });

    expect(openConversationInAgents("conv-1")).toBe(true);

    expect(useAgentTaskStore.getState().selectedConversationId).toBe("conv-1");
    expect(useAppStore.getState().activeView).toBe("agents");
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
    expect(useWorkspaceStore.getState().focusPaneRequest).toBeNull();
  });

  it("leaves view, selection, and Workspaces untouched for a stale id", () => {
    useAppStore.setState({ activeView: "memory" });

    expect(openConversationInAgents("ghost")).toBe(false);

    expect(useAgentTaskStore.getState().selectedConversationId).toBeNull();
    expect(useAppStore.getState().activeView).toBe("memory");
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("keeps the deprecated deep-link alias on the non-materializing Agents path", () => {
    useAgentTaskStore.setState({ conversations: [conversation()] });

    focusConversationDeepLink("conv-1");

    expect(useAppStore.getState().activeView).toBe("agents");
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
  });

  it("audits old-layout compatibility before reconciling an orphan wrapper", () => {
    useAgentTaskStore.setState({ conversations: [conversation()] });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-modern",
          name: "Modern",
          agents: [],
          panes: [
            {
              id: "pane-valid",
              agentId: "terminal",
              sessionId: null,
              kind: "conversation",
              conversationId: "conv-1",
            },
            {
              id: "pane-missing",
              agentId: "terminal",
              sessionId: null,
              kind: "conversation",
              conversationId: "missing-conversation",
            },
          ],
          projectPath: "/proj",
          createdAt: 1,
          updatedAt: 1,
          status: "active",
        },
        {
          id: "ws-orphan",
          name: "Old binary wrapper",
          agents: ["terminal"],
          panes: [
            {
              id: "pane-downgraded",
              agentId: "terminal",
              sessionId: null,
              kind: "terminal",
            },
          ],
          projectPath: "/proj",
          createdAt: 1,
          updatedAt: 1,
          status: "active",
          origin: "conversation",
        },
      ],
    });

    initSessionGlue();

    expect(useWorkspaceAgentsDogfoodStore.getState().evidence.migration).toEqual({
      audits: 1,
      conversationPanes: 2,
      missingConversationReferences: 1,
      orphanConversationWrappers: 1,
    });
    expect(
      useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === "ws-orphan"),
    ).toBe(false);
    expect(
      useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === "ws-modern"),
    ).toBe(true);
  });
});
