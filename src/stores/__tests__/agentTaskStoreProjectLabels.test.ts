import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@/lib/brand";

const listenMock = vi.fn();
const invokeMock = vi.fn();
const loadConversationsMock = vi.fn();

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
    })),
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
  saveAgentsSlice: vi.fn(),
  startApiAgentSession: vi.fn(),
  sendApiAgentMessage: vi.fn(),
  cancelApiAgentSession: vi.fn(),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn(),
  saveConversation: vi.fn().mockResolvedValue(undefined),
  loadConversations: (...args: unknown[]) => loadConversationsMock(...args),
  deleteConversationFile: vi.fn(),
  changeAgentModel: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondPermission: vi.fn(),
  setApproveWrites: vi.fn(),
  respondEdit: vi.fn(),
  retryLastTurn: vi.fn(),
  saveCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
  exportConversationMarkdown: vi.fn(),
}));

const PROJECT_LABELS_KEY = storageKey("project-labels");
const LEGACY_PROJECT_LABELS_KEY = "packetcode:project-labels";

describe("agentTaskStore project label storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock("@/stores/agentTaskStore");
    localStorage.clear();
    listenMock.mockResolvedValue(() => {});
    invokeMock.mockResolvedValue(undefined);
    loadConversationsMock.mockResolvedValue([]);
  });

  it("migrates legacy project labels to the branded storage key", async () => {
    localStorage.setItem(
      LEGACY_PROJECT_LABELS_KEY,
      JSON.stringify({ "D:/projects/old": "Legacy Label" }),
    );

    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    expect(useAgentTaskStore.getState().projectLabels).toEqual({
      "D:/projects/old": "Legacy Label",
    });
    expect(JSON.parse(localStorage.getItem(PROJECT_LABELS_KEY)!)).toEqual({
      "D:/projects/old": "Legacy Label",
    });
  });

  it("writes project labels only to the branded storage key", async () => {
    const { useAgentTaskStore } = await import("@/stores/agentTaskStore");

    useAgentTaskStore
      .getState()
      .setProjectLabel("D:/projects/packetade", "PacketADE");

    expect(JSON.parse(localStorage.getItem(PROJECT_LABELS_KEY)!)).toEqual({
      "D:/projects/packetade": "PacketADE",
    });
    expect(localStorage.getItem(LEGACY_PROJECT_LABELS_KEY)).toBeNull();
  });
});
