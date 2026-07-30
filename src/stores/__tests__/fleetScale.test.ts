/**
 * Tile program (P4-S2) — fleet scale + projection invariants.
 *
 * Asserts the ruled "no bulk migration" model holds at scale:
 *   - 200+ conversations project to 200+ virtual rows with ZERO
 *     conversation-file mutation (no `saveConversation`);
 *   - virtual-row identity is stable across a simulated restart (row id ===
 *     conversationId, deterministic order).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const saveConversationMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "") })) },
}));
vi.mock("@/stores/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(() => ({ setProjectPath: vi.fn(), setActivePaneId: vi.fn() })),
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
  saveConversation: (...a: unknown[]) => saveConversationMock(...a),
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
}));

import { runReconciliationSweep, teardownSessionGlue } from "@/stores/sessionGlue";
import { selectConversationAttention, selectWorkspaceStatuses } from "@/lib/sessionStatus";
import { flightAttemptSessionIds } from "@/lib/sessionIndex";
import { buildFleetProjection } from "@/lib/fleetRows";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import type { AgentConversation } from "@/types/agent-conversation";

function makeConversations(n: number): AgentConversation[] {
  const out: AgentConversation[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `conv-${i}`,
      title: `Task ${i}`,
      agent: "api-claude",
      projectPath: i % 2 === 0 ? "/proj/a" : "/proj/b",
      status: "idle",
      messages: [],
      sessionId: `conv-${i}`,
      rawOutput: "",
      createdAt: i,
      updatedAt: 1000 + i,
      mode: "api",
    });
  }
  return out;
}

function project() {
  const conversations = useAgentTaskStore.getState().conversations;
  const workspaces = useWorkspaceStore.getState().workspaces;
  return buildFleetProjection({
    workspaces,
    conversations,
    conversationAttention: selectConversationAttention(),
    workspaceStatuses: selectWorkspaceStatuses(),
    attemptSessionIds: flightAttemptSessionIds(useFlightStore.getState().flights),
    prefs: {},
    filter: "all",
    query: "",
  });
}

function orderedIds(p: ReturnType<typeof buildFleetProjection>): string[] {
  return [...p.needsYou, ...p.groups.flatMap((g) => g.rows)].map((r) => r.id);
}

const N = 220;

beforeEach(() => {
  vi.clearAllMocks();
  useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
  useFlightStore.setState({ flights: [] });
});

afterEach(() => {
  teardownSessionGlue();
});

describe("fleet scale — 200+ conversations", () => {
  it("projects every unplaced conversation as a virtual row with zero conversation-file mutation", () => {
    useAgentTaskStore.setState({ conversations: makeConversations(N) });
    saveConversationMock.mockClear();

    // Reconciliation sweep is a prerequisite of the fleet layer: with no
    // orphaned wrappers it does nothing and touches no conversation file.
    runReconciliationSweep();

    const p = project();
    const ids = orderedIds(p);
    expect(ids).toHaveLength(N);
    // Every row is a virtual row identified by its conversationId (stable).
    expect(new Set(ids).size).toBe(N);
    expect(ids.every((id) => id.startsWith("conv-"))).toBe(true);
    expect(saveConversationMock).not.toHaveBeenCalled();
  });

  it("virtual-row identity is stable across a simulated restart", () => {
    const convs = makeConversations(N);
    useAgentTaskStore.setState({ conversations: convs });
    const first = orderedIds(project());

    // Simulate a cold restart: same persisted conversations reloaded.
    useAgentTaskStore.setState({ conversations: [] });
    useAgentTaskStore.setState({ conversations: makeConversations(N) });
    const second = orderedIds(project());

    expect(second).toEqual(first);
  });
});
