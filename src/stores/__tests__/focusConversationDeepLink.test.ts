/**
 * Tile program (P5-S1): focusConversationDeepLink — the shared landing used by
 * the retargeted deep-link producers (RunningAgentsChip, PinnedApprovalBanner,
 * the Scout template send) and the "agents" redirect shim.
 *
 * Proves that a deep link:
 *   - materializes the conversation's wrapper workspace (idempotent openSession);
 *   - focus+flashes the conversation's tile (requestPaneFocus) so a notification
 *     deep link lands on the offending tile with its pending approval visible;
 *   - switches the shell to the Workspace surface;
 *   - and, for a vanished conversation, lands on the Workspace surface WITHOUT
 *     materializing a dead wrapper (never blank, never a crash).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "") })) },
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

import { focusConversationDeepLink, conversationWrapperId } from "@/stores/sessionGlue";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useAppStore } from "@/stores/appStore";
import type { AgentConversation } from "@/types/agent-conversation";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
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

describe("focusConversationDeepLink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      zoomedPaneId: null,
      focusPaneRequest: null,
    });
    useLayoutStore.setState({ activePaneId: "", projectPath: "" });
    useAppStore.setState({ activeView: "welcome" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("materializes the wrapper, focus+flashes its tile, and lands on Workspace", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1" })] });

    focusConversationDeepLink("conv-1");

    const wrapId = conversationWrapperId("conv-1");
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.id === wrapId);
    expect(ws).toBeDefined();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(wrapId);

    // Flash targets the conversation pane inside the wrapper.
    const convPane = ws!.panes.find((p) => p.kind === "conversation");
    const req = useWorkspaceStore.getState().focusPaneRequest;
    expect(req).toMatchObject({ workspaceId: wrapId, paneId: convPane!.id });

    // Shell landed on the Workspace surface — never the retired Agents tab.
    expect(useAppStore.getState().activeView).toBe("workspace");
  });

  it("is idempotent — a second deep link reuses the one wrapper", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "conv-1" })] });
    focusConversationDeepLink("conv-1");
    focusConversationDeepLink("conv-1");
    const wrapId = conversationWrapperId("conv-1");
    const wrappers = useWorkspaceStore.getState().workspaces.filter((w) => w.id === wrapId);
    expect(wrappers).toHaveLength(1);
  });

  it("a vanished conversation lands on Workspace without a dead wrapper", () => {
    // No such conversation in the store.
    focusConversationDeepLink("ghost");

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(0);
    expect(useWorkspaceStore.getState().focusPaneRequest).toBeNull();
    expect(useAppStore.getState().activeView).toBe("workspace");
  });
});
