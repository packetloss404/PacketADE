import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingPermission, PendingEdit } from "@/types/agent-conversation";

const respondPermissionMock = vi.fn();
const respondEditMock = vi.fn();
const cancelPendingToolsMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  respondPermission: (...args: unknown[]) => respondPermissionMock(...args),
  respondEdit: (...args: unknown[]) => respondEditMock(...args),
  cancelPendingTools: (...args: unknown[]) => cancelPendingToolsMock(...args),
}));

vi.mock("@/stores/flightStore", () => ({
  useFlightStore: {
    getState: vi.fn(() => ({
      findTaskBySessionId: vi.fn(() => null),
    })),
  },
}));

vi.mock("@/stores/orchestrationStateStore", () => ({
  useOrchestrationStateStore: {
    getState: vi.fn(() => ({
      onTaskApprovalNeeded: vi.fn().mockResolvedValue(undefined),
      onTaskApprovalResolved: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

function makePermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "perm-1",
    name: "bash",
    arguments: '{"command":"ls"}',
    ...overrides,
  };
}

function makeEdit(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: "edit-1",
    path: "src/foo.ts",
    content: "// new content",
    ...overrides,
  };
}

describe("agentApprovalStore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    respondPermissionMock.mockResolvedValue(undefined);
    respondEditMock.mockResolvedValue(undefined);
    cancelPendingToolsMock.mockResolvedValue(undefined);

    // Reset the store between tests so accumulated state from one case
    // doesn't bleed into the next.
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    useAgentApprovalStore.setState({
      permissions: new Map(),
      edits: new Map(),
    });
  });

  it("addPendingPermission stores the entry keyed by conversationId", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const perm = makePermission();

    useAgentApprovalStore.getState().addPendingPermission("conv-A", perm);

    const perms = useAgentApprovalStore.getState().permissions.get("conv-A");
    expect(perms).toEqual([perm]);
    expect(useAgentApprovalStore.getState().permissions.get("conv-B")).toBeUndefined();
  });

  it("addPendingEdit stores the entry keyed by conversationId", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const edit = makeEdit();

    useAgentApprovalStore.getState().addPendingEdit("conv-A", edit);

    const edits = useAgentApprovalStore.getState().edits.get("conv-A");
    expect(edits).toEqual([edit]);
    expect(useAgentApprovalStore.getState().edits.get("conv-B")).toBeUndefined();
  });

  it("addPendingPermission appends multiple entries to the same conversation", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const p1 = makePermission({ id: "perm-1" });
    const p2 = makePermission({ id: "perm-2", name: "write_file" });

    useAgentApprovalStore.getState().addPendingPermission("conv-A", p1);
    useAgentApprovalStore.getState().addPendingPermission("conv-A", p2);

    expect(useAgentApprovalStore.getState().permissions.get("conv-A")).toEqual([p1, p2]);
  });

  it("respondPermission removes the matching toolId from the queue", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const p1 = makePermission({ id: "perm-1" });
    const p2 = makePermission({ id: "perm-2" });
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-A", [p1, p2]]]),
      edits: new Map(),
    });

    await useAgentApprovalStore.getState().respondPermission("conv-A", "perm-1", "allow_once");

    expect(respondPermissionMock).toHaveBeenCalledWith("conv-A", "perm-1", "allow_once");
    expect(useAgentApprovalStore.getState().permissions.get("conv-A")).toEqual([p2]);
  });

  it("respondPermission drops the conversation key when the queue empties", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const p1 = makePermission({ id: "perm-1" });
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-A", [p1]]]),
      edits: new Map(),
    });

    await useAgentApprovalStore.getState().respondPermission("conv-A", "perm-1", "deny");

    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
  });

  it("respondPermission with a mismatched toolId warns and is a state no-op", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const p1 = makePermission({ id: "perm-1" });
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-A", [p1]]]),
      edits: new Map(),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await useAgentApprovalStore
      .getState()
      .respondPermission("conv-A", "does-not-exist", "allow_once");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no pending permission entry for toolId does-not-exist"),
    );
    // Original queue is untouched.
    expect(useAgentApprovalStore.getState().permissions.get("conv-A")).toEqual([p1]);
    warnSpy.mockRestore();
  });

  it("respondEdit removes the matching toolId from the edits queue", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const e1 = makeEdit({ id: "edit-1" });
    const e2 = makeEdit({ id: "edit-2", path: "src/bar.ts" });
    useAgentApprovalStore.setState({
      permissions: new Map(),
      edits: new Map([["conv-A", [e1, e2]]]),
    });

    await useAgentApprovalStore.getState().respondEdit("conv-A", "edit-1", "apply", "merged!");

    expect(respondEditMock).toHaveBeenCalledWith("conv-A", "edit-1", "apply", "merged!");
    expect(useAgentApprovalStore.getState().edits.get("conv-A")).toEqual([e2]);
  });

  it("respondEdit with a mismatched toolId warns and is a state no-op", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const e1 = makeEdit({ id: "edit-1" });
    useAgentApprovalStore.setState({
      permissions: new Map(),
      edits: new Map([["conv-A", [e1]]]),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await useAgentApprovalStore.getState().respondEdit("conv-A", "ghost-id", "reject");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no pending edit entry for toolId ghost-id"),
    );
    expect(useAgentApprovalStore.getState().edits.get("conv-A")).toEqual([e1]);
    warnSpy.mockRestore();
  });

  it("cancelPendingTools drains both queues for the conversation", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-A", [makePermission({ id: "perm-1" })]]]),
      edits: new Map([["conv-A", [makeEdit({ id: "edit-1" })]]]),
    });

    await useAgentApprovalStore.getState().cancelPendingTools("conv-A");

    expect(cancelPendingToolsMock).toHaveBeenCalledWith("conv-A");
    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
    expect(useAgentApprovalStore.getState().edits.has("conv-A")).toBe(false);
  });

  it("clearConversation drops every per-conversation entry", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-A", [makePermission({ id: "perm-1" })]]]),
      edits: new Map([["conv-A", [makeEdit({ id: "edit-1" })]]]),
    });

    useAgentApprovalStore.getState().clearConversation("conv-A");

    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
    expect(useAgentApprovalStore.getState().edits.has("conv-A")).toBe(false);
  });

  it("isolates state across multiple conversations", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const permA = makePermission({ id: "perm-A" });
    const permB = makePermission({ id: "perm-B" });
    const editA = makeEdit({ id: "edit-A" });
    const editB = makeEdit({ id: "edit-B" });

    useAgentApprovalStore.getState().addPendingPermission("conv-A", permA);
    useAgentApprovalStore.getState().addPendingPermission("conv-B", permB);
    useAgentApprovalStore.getState().addPendingEdit("conv-A", editA);
    useAgentApprovalStore.getState().addPendingEdit("conv-B", editB);

    // Resolve only conv-A's permission — conv-B should be untouched.
    await useAgentApprovalStore.getState().respondPermission("conv-A", "perm-A", "allow_once");
    expect(useAgentApprovalStore.getState().permissions.has("conv-A")).toBe(false);
    expect(useAgentApprovalStore.getState().permissions.get("conv-B")).toEqual([permB]);

    // Clear conv-B — conv-A's remaining edit should survive.
    useAgentApprovalStore.getState().clearConversation("conv-B");
    expect(useAgentApprovalStore.getState().edits.get("conv-A")).toEqual([editA]);
    expect(useAgentApprovalStore.getState().permissions.has("conv-B")).toBe(false);
    expect(useAgentApprovalStore.getState().edits.has("conv-B")).toBe(false);
  });

  it("getPendingForConversation returns both queues in one read", async () => {
    const { useAgentApprovalStore } = await import("@/stores/agentApprovalStore");
    const perm = makePermission({ id: "perm-1" });
    const edit = makeEdit({ id: "edit-1" });
    useAgentApprovalStore.setState({
      permissions: new Map([["conv-A", [perm]]]),
      edits: new Map([["conv-A", [edit]]]),
    });

    const result = useAgentApprovalStore.getState().getPendingForConversation("conv-A");

    expect(result.permissions).toEqual([perm]);
    expect(result.edits).toEqual([edit]);
  });

  it("getPendingForConversation reuses stable empty queue references", async () => {
    const {
      EMPTY_PENDING_EDITS,
      EMPTY_PENDING_PERMISSIONS,
      useAgentApprovalStore,
    } = await import("@/stores/agentApprovalStore");

    const first = useAgentApprovalStore.getState().getPendingForConversation("missing-conv");
    const second = useAgentApprovalStore.getState().getPendingForConversation("missing-conv");

    expect(first.permissions).toBe(EMPTY_PENDING_PERMISSIONS);
    expect(first.edits).toBe(EMPTY_PENDING_EDITS);
    expect(second.permissions).toBe(first.permissions);
    expect(second.edits).toBe(first.edits);
  });
});
