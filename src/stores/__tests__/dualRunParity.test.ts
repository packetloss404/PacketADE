/**
 * Tile program (P4-S3) — dual-run parity gate.
 *
 * The old AgentSidebar and the new FleetSidebar must agree on the needs-you
 * count for the SAME store state. AgentSidebar's needs-you predicate is
 * "a non-archived conversation with a pending permission or edit"
 * (AgentSidebar.tsx: `needsYou(id) = perms + edits > 0`); FleetSidebar derives
 * needs-you from the single-truth `sessionStatus` attention projection
 * (`attention === "needs_you"`). On the shared approval state these two counts
 * must be identical — this test asserts that invariant across several store
 * shapes.
 *
 * Parity checklist tracked in the PR (all carried into FleetSidebar in P4-S2 and
 * exercised by FleetSidebar.test.tsx): search (/-search with message scan),
 * pins, archive filter, project rename. This file pins the needs-you-count leg,
 * which is the ruled numeric gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { buildFleetProjection } from "@/lib/fleetRows";
import { selectConversationAttention, selectWorkspaceStatuses } from "@/lib/sessionStatus";
import { flightAttemptSessionIds } from "@/lib/sessionIndex";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import type { AgentConversation, PendingPermission, PendingEdit } from "@/types/agent-conversation";

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: "conv-1",
    title: "Task",
    agent: "api-claude",
    projectPath: "/proj",
    status: "idle",
    messages: [],
    sessionId: "conv-1",
    rawOutput: "",
    createdAt: 1,
    updatedAt: 1,
    mode: "api",
    ...overrides,
  };
}

/** AgentSidebar's needs-you predicate, verbatim (perms+edits, non-archived). */
function agentSidebarNeedsYouCount(
  conversations: AgentConversation[],
  perms: Map<string, PendingPermission[]>,
  edits: Map<string, PendingEdit[]>,
): number {
  return conversations.filter(
    (c) => !c.archived && (perms.get(c.id)?.length ?? 0) + (edits.get(c.id)?.length ?? 0) > 0,
  ).length;
}

/** FleetSidebar's needs-you count = the pinned needs-you pseudo-group size. */
function fleetSidebarNeedsYouCount(): number {
  const conversations = useAgentTaskStore.getState().conversations;
  const workspaces = useWorkspaceStore.getState().workspaces;
  const projection = buildFleetProjection({
    workspaces,
    conversations,
    conversationAttention: selectConversationAttention(),
    workspaceStatuses: selectWorkspaceStatuses(),
    attemptSessionIds: flightAttemptSessionIds(useFlightStore.getState().flights),
    prefs: {},
    filter: "all",
    query: "",
  });
  return projection.needsYou.length;
}

const perm = (): PendingPermission => ({
  id: "p1",
  toolName: "bash",
  input: {},
  timestamp: 1,
}) as unknown as PendingPermission;

beforeEach(() => {
  vi.clearAllMocks();
  useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
  useFlightStore.setState({ flights: [] });
  useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
});

describe("dual-run parity — needs-you counts agree on shared store state", () => {
  it("zero pending ⇒ both zero", () => {
    useAgentTaskStore.setState({ conversations: [conv({ id: "a" }), conv({ id: "b" })] });
    const perms = useAgentApprovalStore.getState().permissions;
    const edits = useAgentApprovalStore.getState().edits;
    expect(fleetSidebarNeedsYouCount()).toBe(
      agentSidebarNeedsYouCount(useAgentTaskStore.getState().conversations, perms, edits),
    );
    expect(fleetSidebarNeedsYouCount()).toBe(0);
  });

  it("some conversations with pending permissions ⇒ identical counts", () => {
    useAgentTaskStore.setState({
      conversations: [conv({ id: "a" }), conv({ id: "b" }), conv({ id: "c" })],
    });
    useAgentApprovalStore.setState({
      permissions: new Map([
        ["a", [perm()]],
        ["c", [perm()]],
      ]),
      edits: new Map(),
    });
    const perms = useAgentApprovalStore.getState().permissions;
    const edits = useAgentApprovalStore.getState().edits;
    expect(fleetSidebarNeedsYouCount()).toBe(
      agentSidebarNeedsYouCount(useAgentTaskStore.getState().conversations, perms, edits),
    );
    expect(fleetSidebarNeedsYouCount()).toBe(2);
  });

  it("archived conversations are excluded by BOTH", () => {
    useAgentTaskStore.setState({
      conversations: [conv({ id: "a", archived: true }), conv({ id: "b" })],
    });
    useAgentApprovalStore.setState({
      permissions: new Map([
        ["a", [perm()]], // archived — must not count
        ["b", [perm()]],
      ]),
      edits: new Map(),
    });
    const perms = useAgentApprovalStore.getState().permissions;
    const edits = useAgentApprovalStore.getState().edits;
    expect(fleetSidebarNeedsYouCount()).toBe(
      agentSidebarNeedsYouCount(useAgentTaskStore.getState().conversations, perms, edits),
    );
    expect(fleetSidebarNeedsYouCount()).toBe(1);
  });
});
