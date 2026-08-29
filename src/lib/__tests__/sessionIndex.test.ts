import { beforeEach, describe, expect, it, vi } from "vitest";

// sessionIndex imports the two engines (agentTaskStore hydrates at module load),
// so mock the tauri/env surface the store graph pulls in — mirrors the existing
// store test harness.
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
  cancelApiAgentSession: vi.fn(),
  cancelPendingTools: vi.fn(),
  closeApiAgentSession: vi.fn(),
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

import {
  attentionFor,
  flightAttemptSessionIds,
  projectConversationSessions,
  selectConversationSessions,
  type ProjectSessionsInput,
} from "@/lib/sessionIndex";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace, WorkspacePane } from "@/types/workspace";
import type { Flight } from "@/types/flight";

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

function emptyInput(over: Partial<ProjectSessionsInput> = {}): ProjectSessionsInput {
  return {
    conversations: [],
    workspaces: [],
    attemptSessionIds: new Set(),
    approvals: { permissions: new Map(), edits: new Map() },
    plans: { plan: new Map(), planApproved: new Map() },
    ...over,
  };
}

describe("attentionFor — vocabulary mapping per source state", () => {
  it("conversation: pending approval outranks everything → needs_you", () => {
    expect(
      attentionFor({
        kind: "conversation",
        status: "active",
        hasPendingApproval: true,
        hasPendingPlan: false,
        isStreaming: true,
      }),
    ).toBe("needs_you");
  });

  it("conversation: pending plan → needs_you", () => {
    expect(
      attentionFor({
        kind: "conversation",
        status: "idle",
        hasPendingApproval: false,
        hasPendingPlan: true,
        isStreaming: false,
      }),
    ).toBe("needs_you");
  });

  it("conversation: failed status → failed", () => {
    expect(
      attentionFor({
        kind: "conversation",
        status: "failed",
        hasPendingApproval: false,
        hasPendingPlan: false,
        isStreaming: false,
      }),
    ).toBe("failed");
  });

  it("conversation: done status → done", () => {
    expect(
      attentionFor({
        kind: "conversation",
        status: "done",
        hasPendingApproval: false,
        hasPendingPlan: false,
        isStreaming: false,
      }),
    ).toBe("done");
  });

  it("conversation: active / streaming → working", () => {
    expect(
      attentionFor({
        kind: "conversation",
        status: "active",
        hasPendingApproval: false,
        hasPendingPlan: false,
        isStreaming: false,
      }),
    ).toBe("working");
    expect(
      attentionFor({
        kind: "conversation",
        status: "idle",
        hasPendingApproval: false,
        hasPendingPlan: false,
        isStreaming: true,
      }),
    ).toBe("working");
  });

  it("conversation: quiet idle → idle", () => {
    expect(
      attentionFor({
        kind: "conversation",
        status: "idle",
        hasPendingApproval: false,
        hasPendingPlan: false,
        isStreaming: false,
      }),
    ).toBe("idle");
  });

  it("pty: needs_you only on approval_needed; never done/failed", () => {
    expect(attentionFor({ kind: "pty", signal: "approval_needed" })).toBe("needs_you");
    expect(attentionFor({ kind: "pty", signal: "working" })).toBe("working");
    expect(attentionFor({ kind: "pty", signal: "idle" })).toBe("idle");
  });
});

describe("projectConversationSessions", () => {
  it("enumerates archived conversations (not filtered out)", () => {
    const rows = projectConversationSessions(
      emptyInput({ conversations: [conv({ id: "c-arch", archived: true })] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("c-arch");
    expect(rows[0].archived).toBe(true);
  });

  it("excludes flight-attempt conversations (attempt sessionIds absent)", () => {
    const rows = projectConversationSessions(
      emptyInput({
        conversations: [conv({ id: "c-real" }), conv({ id: "attempt-xyz" })],
        attemptSessionIds: new Set(["attempt-xyz"]),
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["c-real"]);
  });

  it("stamps placement from a referencing conversation pane; unplaced otherwise", () => {
    const pane: WorkspacePane = {
      id: "pane-9",
      agentId: "terminal",
      sessionId: null,
      kind: "conversation",
      conversationId: "c-placed",
    };
    const ws: Workspace = {
      id: "ws-1",
      name: "W",
      agents: [],
      panes: [pane],
      projectPath: "/proj",
      createdAt: 1,
      updatedAt: 1,
      status: "active",
    };
    const rows = projectConversationSessions(
      emptyInput({
        conversations: [conv({ id: "c-placed" }), conv({ id: "c-unplaced" })],
        workspaces: [ws],
      }),
    );
    const placed = rows.find((r) => r.id === "c-placed")!;
    const unplaced = rows.find((r) => r.id === "c-unplaced")!;
    expect(placed.workspaceId).toBe("ws-1");
    expect(placed.paneId).toBe("pane-9");
    expect(unplaced.workspaceId).toBeUndefined();
    expect(unplaced.paneId).toBeUndefined();
  });

  it("derives attention from approval / plan / status", () => {
    const rows = projectConversationSessions(
      emptyInput({
        conversations: [
          conv({ id: "c-approve" }),
          conv({ id: "c-fail", status: "failed" }),
          conv({ id: "c-plan", planMode: true }),
        ],
        approvals: {
          permissions: new Map([["c-approve", [{ id: "t1", name: "bash", arguments: "" }]]]),
          edits: new Map(),
        },
        plans: {
          plan: new Map([["c-plan", [{ content: "step", status: "pending" }]]]),
          planApproved: new Map(),
        },
      }),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.attention]));
    expect(byId["c-approve"]).toBe("needs_you");
    expect(byId["c-fail"]).toBe("failed");
    expect(byId["c-plan"]).toBe("needs_you");
  });
});

describe("flightAttemptSessionIds", () => {
  function flightWith(sessionIds: string[]): Flight {
    return {
      id: "f1",
      title: "F",
      objective: "",
      status: "active",
      priority: "medium",
      projectPath: "/proj",
      workspaceId: null,
      milestones: [],
      linkedSessionIds: [],
      issueIds: [],
      createdAt: 1,
      updatedAt: 1,
      totalCost: 0,
      totalTokens: 0,
      attempts: sessionIds.map((sid, i) => ({
        id: `a${i}`,
        flightId: "f1",
        target: { kind: "local", basePath: "/p", worktreePath: "/w" },
        agentConfigId: "x",
        model: "m",
        provider: "p",
        branch: "b",
        baseBranch: "main",
        sessionId: sid,
        status: "running" as const,
        cost: 0,
        tokens: 0,
      })),
    };
  }

  it("collects every attempt sessionId across flights", () => {
    const set = flightAttemptSessionIds([flightWith(["s1", "s2"]), flightWith(["s3"])]);
    expect([...set].sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("memoizes on the flights array reference", () => {
    const flights = [flightWith(["s1"])];
    const a = flightAttemptSessionIds(flights);
    const b = flightAttemptSessionIds(flights);
    expect(a).toBe(b);
    // A fresh array (even with identical contents) recomputes.
    const c = flightAttemptSessionIds([flightWith(["s1"])]);
    expect(c).not.toBe(a);
  });
});

describe("selectConversationSessions — live store wiring", () => {
  beforeEach(() => {
    useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
    useFlightStore.setState({ flights: [] });
  });

  it("projects live conversations and excludes live flight attempts", () => {
    useAgentTaskStore.setState({
      conversations: [conv({ id: "c-live" }), conv({ id: "attempt-live" })],
    });
    useFlightStore.setState({
      flights: [
        {
          id: "f1",
          title: "F",
          objective: "",
          status: "active",
          priority: "medium",
          projectPath: "/proj",
          workspaceId: null,
          milestones: [],
          linkedSessionIds: [],
          issueIds: [],
          createdAt: 1,
          updatedAt: 1,
          totalCost: 0,
          totalTokens: 0,
          attempts: [
            {
              id: "a0",
              flightId: "f1",
              target: { kind: "local", basePath: "/p", worktreePath: "/w" },
              agentConfigId: "x",
              model: "m",
              provider: "p",
              branch: "b",
              baseBranch: "main",
              sessionId: "attempt-live",
              status: "running",
              cost: 0,
              tokens: 0,
            },
          ],
        },
      ],
    });
    const rows = selectConversationSessions();
    expect(rows.map((r) => r.id)).toEqual(["c-live"]);
  });
});
