import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchConversationParams } from "@/lib/launchConversation";

/**
 * Unit coverage for the launch extraction (tile-program P1-S3, D). Exercises
 * the REAL `agentTaskStore.createApiConversation` so the worktree stamp lands
 * on the real conversation record; only the Tauri boundary (backend start +
 * worktree provisioning) is mocked. Asserts:
 *   - worktree mode stamps `conversation.worktree` with
 *     basePath / worktreePath / branch / baseBranch / state:"active".
 *   - provisioning failure falls back to the project root and stamps NO
 *     worktree (the root-cause fix must degrade gracefully).
 */

const listenMock = vi.fn();
const invokeMock = vi.fn();
const startApiAgentSessionMock = vi.fn();
const getGitBranchMock = vi.fn();
const createConversationWorktreeMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/agentsMd", () => ({
  loadAgentsMd: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: {
    getState: vi.fn(() => ({
      getContextForSession: vi.fn(() => ""),
      composeMemoryBrief: vi.fn(() => ({ text: "" })),
    })),
  },
}));

vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({ setProjectPath: vi.fn() })),
  },
}));

vi.mock("@/lib/tauri", () => ({
  createPtySession: vi.fn(),
  writePty: vi.fn(),
  killPty: vi.fn(),
  readPtyTranscript: vi.fn().mockResolvedValue({ data: "" }),
  listPtySessions: vi.fn().mockResolvedValue([]),
  detectAgent: vi.fn(),
  loadPersistedState: vi.fn(),
  saveAgentsSlice: vi.fn().mockResolvedValue(undefined),
  startApiAgentSession: (...args: unknown[]) => startApiAgentSessionMock(...args),
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
  saveWorkspacesSlice: vi.fn().mockResolvedValue(undefined),
  getGitBranch: (...args: unknown[]) => getGitBranchMock(...args),
  createConversationWorktree: (...args: unknown[]) => createConversationWorktreeMock(...args),
}));

const SELECTED_REPO = "D:/projects/example";

function baseParams(overrides: Partial<LaunchConversationParams> = {}): LaunchConversationParams {
  return {
    rawText: "do the thing",
    attachments: [],
    selectedRepo: SELECTED_REPO,
    selectedAgent: "api-openai",
    selectedModel: "gpt-4o",
    agentMode: "agent",
    composerMode: "local",
    profile: undefined,
    setLaunchError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.doUnmock("@/stores/agentTaskStore");
  localStorage.clear();
  listenMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue(undefined);
  startApiAgentSessionMock.mockResolvedValue(undefined);
});

describe("launchConversation — worktree stamping", () => {
  it("stamps conversation.worktree (basePath/worktreePath/branch/baseBranch/state) when provisioning succeeds", async () => {
    const wtPath = `${SELECTED_REPO}/.pkt-worktrees/generated`;
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockResolvedValue(wtPath);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    const dispatched = launchConversation(baseParams({ composerMode: "worktree" }));
    expect(dispatched).toBe(true);

    await vi.waitFor(() => {
      const conv = useAgentTaskStore.getState().conversations[0];
      expect(conv?.worktree).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(createConversationWorktreeMock).toHaveBeenCalledTimes(1);
    // The conversation runs INSIDE the worktree.
    expect(conv?.projectPath).toBe(wtPath);
    expect(conv?.worktree).toEqual({
      basePath: SELECTED_REPO,
      worktreePath: wtPath,
      branch: `pkt/${conv?.id}`,
      baseBranch: "main",
      createdAt: expect.any(Number),
      state: "active",
    });
  });

  it("falls back to HEAD as baseBranch when the current branch can't be read", async () => {
    const wtPath = `${SELECTED_REPO}/.pkt-worktrees/generated`;
    getGitBranchMock.mockRejectedValue(new Error("detached"));
    createConversationWorktreeMock.mockResolvedValue(wtPath);

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    launchConversation(baseParams({ composerMode: "worktree" }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]?.worktree).toBeDefined();
    });

    expect(useAgentTaskStore.getState().conversations[0]?.worktree?.baseBranch).toBe("HEAD");
    // getGitBranch was cut off with an explicit HEAD base handed to provisioning.
    expect(createConversationWorktreeMock).toHaveBeenCalledWith(SELECTED_REPO, expect.any(String), "HEAD");
  });
});

describe("launchConversation — fallback to project root on provisioning failure", () => {
  it("runs in the project root and stamps NO worktree when provisioning throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getGitBranchMock.mockResolvedValue("main");
    createConversationWorktreeMock.mockRejectedValue(new Error("worktree add failed"));

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    launchConversation(baseParams({ composerMode: "worktree" }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(createConversationWorktreeMock).toHaveBeenCalledTimes(1);
    expect(conv?.projectPath).toBe(SELECTED_REPO);
    expect(conv?.worktree).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("local (non-worktree) mode never provisions a worktree and stamps none", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");
    const { launchConversation } = await import("@/lib/launchConversation");

    launchConversation(baseParams({ composerMode: "local" }));

    await vi.waitFor(() => {
      expect(useAgentTaskStore.getState().conversations[0]).toBeDefined();
    });

    const conv = useAgentTaskStore.getState().conversations[0];
    expect(createConversationWorktreeMock).not.toHaveBeenCalled();
    expect(conv?.projectPath).toBe(SELECTED_REPO);
    expect(conv?.worktree).toBeUndefined();
  });
});

describe("launchConversation — synchronous guards (behavior parity)", () => {
  it("returns false for empty text and dispatches nothing", async () => {
    const { launchConversation } = await import("@/lib/launchConversation");
    expect(launchConversation(baseParams({ rawText: "   " }))).toBe(false);
    expect(startApiAgentSessionMock).not.toHaveBeenCalled();
  });

  it("returns false when no repo is selected", async () => {
    const { launchConversation } = await import("@/lib/launchConversation");
    expect(launchConversation(baseParams({ selectedRepo: null }))).toBe(false);
  });
});
