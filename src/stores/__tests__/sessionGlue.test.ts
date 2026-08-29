import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveConversationMock = vi.fn().mockResolvedValue(undefined);
const saveWorkspacesSliceMock = vi.fn().mockResolvedValue(undefined);
const deleteConversationFileMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ setProjectPath: vi.fn() })) },
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
  saveConversation: (...a: unknown[]) => saveConversationMock(...a),
  // Inline (not an outer const): hydrateConversations() calls this during the
  // store module's load-time evaluation, before this file's const initializers
  // run — an outer-const ref would hit a TDZ error.
  loadConversations: vi.fn().mockResolvedValue([]),
  deleteConversationFile: (...a: unknown[]) => deleteConversationFileMock(...a),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  exportConversationMarkdown: vi.fn(),
  saveWorkspacesSlice: (...a: unknown[]) => saveWorkspacesSliceMock(...a),
}));

import {
  runReconciliationSweep,
  installConversationGc,
  conversationWrapperId,
  teardownSessionGlue,
} from "@/stores/sessionGlue";
import { selectConversationSessions } from "@/lib/sessionIndex";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace, WorkspacePane } from "@/types/workspace";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "My Task",
    agent: "api-claude",
    projectPath: "/proj",
    status: "done",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

function conversationPane(conversationId: string): WorkspacePane {
  return {
    id: `pane-${conversationId}`,
    agentId: "terminal",
    sessionId: null,
    kind: "conversation",
    conversationId,
  };
}

function terminalPane(id: string): WorkspacePane {
  return { id, agentId: "terminal", sessionId: null };
}

function wrapperWorkspace(conversationId: string, panes: WorkspacePane[]): Workspace {
  return {
    id: conversationWrapperId(conversationId),
    name: "My Task",
    agents: [],
    panes,
    projectPath: "/proj",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    origin: "conversation",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
});

afterEach(() => {
  teardownSessionGlue();
});

describe("sessionGlue — one-directional GC", () => {
  it("prunes referencing panes when a conversation is deleted", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1" })] });
    useWorkspaceStore.setState({
      workspaces: [wrapperWorkspace("conv-1", [conversationPane("conv-1")])],
    });
    // Install AFTER seeding so the GC baseline includes conv-1.
    installConversationGc();

    useAgentTaskStore.getState().deleteConversation("conv-1");

    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === "ws-wrap-conv-1");
    expect(ws!.panes.some((p) => p.conversationId === "conv-1")).toBe(false);
  });

  it("never deletes the conversation when a tile is closed (reverse is a no-op)", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1" })] });
    useWorkspaceStore.setState({
      workspaces: [wrapperWorkspace("conv-1", [conversationPane("conv-1")])],
    });
    installConversationGc();

    // Closing the tile = pruning the pane directly; the conversation must live.
    useWorkspaceStore.getState().removeConversationPanes("conv-1");

    expect(useAgentTaskStore.getState().conversations.some((c) => c.id === "conv-1")).toBe(true);
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === "ws-wrap-conv-1");
    expect(ws!.panes).toHaveLength(0);
  });
});

describe("sessionGlue — reconciliation sweep (self-heal)", () => {
  it("re-surfaces a stripped-pane conversation as an unplaced row, zero conversation-file mutation", () => {
    // The wrapper's conversation pane was stripped to a plain terminal pane by an
    // old-binary re-save (normalizePanes degrades it); the conversation record is
    // untouched on disk.
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1", archived: false })] });
    useWorkspaceStore.setState({
      workspaces: [wrapperWorkspace("conv-1", [terminalPane("pane-stripped")])],
    });
    saveConversationMock.mockClear();

    runReconciliationSweep();

    // Ghost wrapper removed.
    expect(
      useWorkspaceStore.getState().workspaces.find((w) => w.id === "ws-wrap-conv-1"),
    ).toBeUndefined();
    // Conversation untouched: still present, and NO conversation file was written.
    expect(useAgentTaskStore.getState().conversations.some((c) => c.id === "conv-1")).toBe(true);
    expect(saveConversationMock).not.toHaveBeenCalled();
    // Projects as an unplaced fleet row.
    const row = selectConversationSessions().find((r) => r.id === "conv-1");
    expect(row).toBeDefined();
    expect(row!.workspaceId).toBeUndefined();
  });

  it("is idempotent — a second run does nothing", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1" })] });
    useWorkspaceStore.setState({
      workspaces: [wrapperWorkspace("conv-1", [terminalPane("pane-stripped")])],
    });
    runReconciliationSweep();
    saveWorkspacesSliceMock.mockClear();
    runReconciliationSweep();
    expect(saveWorkspacesSliceMock).not.toHaveBeenCalled();
  });

  it("leaves a healthy wrapper (with its conversation pane) alone", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1" })] });
    useWorkspaceStore.setState({
      workspaces: [wrapperWorkspace("conv-1", [conversationPane("conv-1")])],
    });
    runReconciliationSweep();
    expect(
      useWorkspaceStore.getState().workspaces.find((w) => w.id === "ws-wrap-conv-1"),
    ).toBeDefined();
  });
});
