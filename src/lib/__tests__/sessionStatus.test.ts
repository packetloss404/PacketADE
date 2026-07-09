/**
 * Tile program (P4-S1) — sessionStatus: the SINGLE status truth.
 *
 * Covers:
 *   - the rollup truth table (max severity across member tiles; empty → idle);
 *   - PTY tiles only ever contribute working/idle (never done/failed);
 *   - mixed conversation + PTY workspaces roll up to the max severity;
 *   - the shared attention → dot visual mapping;
 *   - the live selectors read the same single truth the tab-strip dot and the
 *     RunningAgentsChip consume.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// sessionStatus pulls in the store graph (agentTaskStore hydrates at module
// load), so mock the tauri/env surface exactly as the sessionIndex suite does.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/agentsMd", () => ({ loadAgentsMd: vi.fn().mockResolvedValue(null) }));
vi.mock("@/stores/memoryStore", () => ({
  useMemoryStore: { getState: vi.fn(() => ({ getContextForSession: vi.fn(() => "") })) },
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
  attentionDot,
  computeWorkspaceStatus,
  paneAttention,
  rollupAttention,
  selectConversationAttention,
  selectWorkspaceStatus,
  selectWorkspaceStatuses,
  type Attention,
} from "@/lib/sessionStatus";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentApprovalStore } from "@/stores/agentApprovalStore";
import { useAgentPlanStore } from "@/stores/agentPlanStore";
import type { AgentConversation } from "@/types/agent-conversation";
import type { Workspace, WorkspacePane } from "@/types/workspace";

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

function convPane(id: string, conversationId: string): WorkspacePane {
  return { id, agentId: "terminal", sessionId: null, kind: "conversation", conversationId };
}

function termPane(id: string, sessionId: string | null): WorkspacePane {
  return { id, agentId: "terminal", sessionId };
}

function ws(id: string, panes: WorkspacePane[]): Workspace {
  return {
    id,
    name: id,
    agents: [],
    panes,
    projectPath: "/proj",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  };
}

describe("rollupAttention — max severity across member tiles", () => {
  it("empty workspace collapses to idle", () => {
    expect(rollupAttention([])).toBe("idle");
  });

  it("needs_you outranks everything", () => {
    expect(rollupAttention(["failed", "done", "idle", "working", "needs_you"])).toBe("needs_you");
  });

  it("working outranks idle/done/failed", () => {
    expect(rollupAttention(["failed", "done", "idle", "working"])).toBe("working");
  });

  it("idle outranks done/failed (ruled order: idle > done > failed)", () => {
    expect(rollupAttention(["failed", "done", "idle"])).toBe("idle");
  });

  it("done outranks failed", () => {
    expect(rollupAttention(["failed", "done"])).toBe("done");
    expect(rollupAttention(["failed", "failed"])).toBe("failed");
  });

  it("single member rolls up to itself", () => {
    (["needs_you", "working", "idle", "done", "failed"] as Attention[]).forEach((a) => {
      expect(rollupAttention([a])).toBe(a);
    });
  });
});

describe("paneAttention — PTY tiles only ever contribute working/idle", () => {
  const empty = new Map<string, Attention>();

  it("live PTY (bound session) → working; dead PTY → idle", () => {
    expect(paneAttention(termPane("p1", "sess"), empty)).toBe("working");
    expect(paneAttention(termPane("p2", null), empty)).toBe("idle");
  });

  it("PTY never yields done/failed even with a wild ptyAttention (typed working|idle)", () => {
    const pty = new Map<string, "working" | "idle">([["p1", "idle"]]);
    expect(paneAttention(termPane("p1", "sess"), empty, pty)).toBe("idle");
  });

  it("conversation pane reads projected attention; missing conversation → idle", () => {
    const convAttn = new Map<string, Attention>([["c1", "needs_you"]]);
    expect(paneAttention(convPane("p1", "c1"), convAttn)).toBe("needs_you");
    expect(paneAttention(convPane("p2", "gone"), convAttn)).toBe("idle");
  });
});

describe("computeWorkspaceStatus — mixed conversation + PTY", () => {
  it("a failed conversation beside a live PTY rolls up to working (working > failed)", () => {
    const convAttn = new Map<string, Attention>([["c1", "failed"]]);
    const w = ws("w", [convPane("p1", "c1"), termPane("p2", "sess")]);
    expect(computeWorkspaceStatus(w, convAttn)).toBe("working");
  });

  it("a needs_you conversation dominates a live PTY", () => {
    const convAttn = new Map<string, Attention>([["c1", "needs_you"]]);
    const w = ws("w", [convPane("p1", "c1"), termPane("p2", "sess")]);
    expect(computeWorkspaceStatus(w, convAttn)).toBe("needs_you");
  });

  it("all-idle members roll up to idle", () => {
    const convAttn = new Map<string, Attention>([["c1", "idle"]]);
    const w = ws("w", [convPane("p1", "c1"), termPane("p2", null)]);
    expect(computeWorkspaceStatus(w, convAttn)).toBe("idle");
  });
});

describe("attentionDot — one shared visual mapping", () => {
  it("needs_you/working pulse; done/failed/idle do not", () => {
    expect(attentionDot("needs_you")).toEqual({ className: "bg-accent-amber", pulse: true });
    expect(attentionDot("working")).toEqual({ className: "bg-accent-green", pulse: true });
    expect(attentionDot("done")).toEqual({ className: "bg-accent-blue", pulse: false });
    expect(attentionDot("failed")).toEqual({ className: "bg-accent-red", pulse: false });
    expect(attentionDot("idle")).toEqual({ className: "bg-text-faint", pulse: false });
  });
});

describe("live selectors — single truth read from the stores", () => {
  beforeEach(() => {
    useAgentTaskStore.setState({ conversations: [], selectedConversationId: null });
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, zoomedPaneId: null });
    useFlightStore.setState({ flights: [] });
    useAgentApprovalStore.setState({ permissions: new Map(), edits: new Map() });
    useAgentPlanStore.setState({ plan: new Map(), planApproved: new Map() });
  });

  it("selectConversationAttention maps each conversation to its attention", () => {
    useAgentTaskStore.setState({
      conversations: [
        conv({ id: "c-work", status: "active", messages: [{ role: "assistant", content: "", isStreaming: true } as never] }),
        conv({ id: "c-need" }),
        conv({ id: "c-done", status: "done" }),
      ],
    });
    useAgentApprovalStore.setState({
      permissions: new Map([["c-need", [{ id: "t", name: "bash", arguments: "" }]]]),
      edits: new Map(),
    });
    const attn = selectConversationAttention();
    expect(attn.get("c-work")).toBe("working");
    expect(attn.get("c-need")).toBe("needs_you");
    expect(attn.get("c-done")).toBe("done");
  });

  it("selectWorkspaceStatuses rolls each workspace up from the same conversation truth", () => {
    useAgentTaskStore.setState({
      conversations: [
        conv({ id: "c-need" }),
        conv({ id: "c-idle", status: "idle" }),
      ],
    });
    useAgentApprovalStore.setState({
      permissions: new Map([["c-need", [{ id: "t", name: "bash", arguments: "" }]]]),
      edits: new Map(),
    });
    useWorkspaceStore.setState({
      workspaces: [
        ws("w-need", [convPane("p1", "c-need"), termPane("p2", null)]),
        ws("w-idle", [convPane("p3", "c-idle")]),
        ws("w-live", [termPane("p4", "sess")]),
        ws("w-empty", []),
      ],
    });
    const statuses = selectWorkspaceStatuses();
    expect(statuses.get("w-need")).toBe("needs_you");
    expect(statuses.get("w-idle")).toBe("idle");
    expect(statuses.get("w-live")).toBe("working");
    expect(statuses.get("w-empty")).toBe("idle");

    // Per-workspace convenience selector agrees; unknown workspace → idle.
    expect(selectWorkspaceStatus("w-need")).toBe("needs_you");
    expect(selectWorkspaceStatus("nope")).toBe("idle");
  });
});
