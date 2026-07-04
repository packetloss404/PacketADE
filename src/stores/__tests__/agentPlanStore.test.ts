import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentPlanItem } from "@/types/agent-conversation";

const requestConversationSaveMock = vi.fn();
const sendMessageMock = vi.fn();
const setPlanModeMock = vi.fn().mockResolvedValue(undefined);
const setPermissionModeMock = vi.fn().mockResolvedValue(undefined);
const setApproveWritesMock = vi.fn().mockResolvedValue(undefined);
let mockConversations: Array<Partial<AgentConversation> & { id: string }> = [];

// agentPlanStore lazily imports agentTaskStore inside its actions to avoid a
// circular-import deadlock. Stub the whole module so we can observe the
// debounced-save + execute-turn side-effects without dragging in the real
// conversation store.
vi.mock("@/stores/agentTaskStore", () => ({
  requestConversationSave: (...args: unknown[]) => requestConversationSaveMock(...args),
  useAgentTaskStore: {
    getState: vi.fn(() => ({
      conversations: mockConversations,
      sendMessage: (...args: unknown[]) => sendMessageMock(...args),
      setPlanMode: (...args: unknown[]) => setPlanModeMock(...args),
      setPermissionMode: (...args: unknown[]) => setPermissionModeMock(...args),
      setApproveWrites: (...args: unknown[]) => setApproveWritesMock(...args),
    })),
  },
}));

function makePlanItem(overrides: Partial<AgentPlanItem> = {}): AgentPlanItem {
  return {
    id: "task-1",
    content: "Investigate the input area",
    status: "pending",
    ...overrides,
  };
}

/** Let approvePlan's dynamic import + async chain settle. */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("agentPlanStore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockConversations = [];

    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      plan: new Map(),
      planApproved: new Map(),
    });
  });

  it("setPlan stores the plan array and schedules a persistence save", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    const items = [
      makePlanItem({ id: "a", content: "Read the file" }),
      makePlanItem({ id: "b", content: "Edit the file", status: "in_progress" }),
    ];

    useAgentPlanStore.getState().setPlan("conv-A", items);
    await flushAsync();

    expect(useAgentPlanStore.getState().plan.get("conv-A")).toEqual(items);
    expect(requestConversationSaveMock).toHaveBeenCalledWith("conv-A");
  });

  it("approvePlan flips planApproved and dispatches the default execute turn", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      plan: new Map([["conv-A", [makePlanItem()]]]),
      planApproved: new Map(),
    });

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();

    expect(useAgentPlanStore.getState().planApproved.get("conv-A")).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      "conv-A",
      "Plan approved. Execute step-by-step, marking TodoWrite items as you complete them.",
    );
    expect(requestConversationSaveMock).toHaveBeenCalledWith("conv-A");
  });

  it("approvePlan sends the caller-supplied posture message when given (unified approval path)", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore
      .getState()
      .approvePlan("conv-A", "Plan approved — implement it now.");
    await flushAsync();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      "conv-A",
      "Plan approved — implement it now.",
    );
  });

  it("approvePlan lifts plan mode BEFORE dispatching the execute turn when it was on", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    mockConversations = [{ id: "conv-A", planMode: true }];
    const order: string[] = [];
    setPlanModeMock.mockImplementation(async () => {
      order.push("setPlanMode");
    });
    sendMessageMock.mockImplementation(() => {
      order.push("sendMessage");
    });

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();

    expect(setPlanModeMock).toHaveBeenCalledWith("conv-A", false);
    expect(order).toEqual(["setPlanMode", "sendMessage"]);
  });

  it("approvePlan applies the permission posture AFTER lifting plan mode and BEFORE dispatch (sidecar shares one plan/permission wire dimension)", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    mockConversations = [{ id: "conv-A", planMode: true }];
    const order: string[] = [];
    setPlanModeMock.mockImplementation(async () => {
      order.push("setPlanMode");
    });
    setPermissionModeMock.mockImplementation(async () => {
      order.push("setPermissionMode");
    });
    setApproveWritesMock.mockImplementation(async () => {
      order.push("setApproveWrites");
    });
    sendMessageMock.mockImplementation(() => {
      order.push("sendMessage");
    });

    useAgentPlanStore
      .getState()
      .approvePlan("conv-A", "Plan approved — implement it now.", {
        permissionMode: "auto",
        approveWrites: false,
      });
    await flushAsync();

    // setPlanMode(false) resets sidecar permission mode to "default", so the
    // posture MUST land after the lift or the backend ends up in "default"
    // while the frontend records "auto".
    expect(order).toEqual([
      "setPlanMode",
      "setPermissionMode",
      "setApproveWrites",
      "sendMessage",
    ]);
    expect(setPermissionModeMock).toHaveBeenCalledWith("conv-A", "auto");
    expect(setApproveWritesMock).toHaveBeenCalledWith("conv-A", false);
  });

  it("approvePlan skips posture calls entirely when no posture is given", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    setPlanModeMock.mockResolvedValue(undefined);
    setPermissionModeMock.mockResolvedValue(undefined);
    setApproveWritesMock.mockResolvedValue(undefined);
    sendMessageMock.mockImplementation(() => {});

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();

    expect(setPermissionModeMock).not.toHaveBeenCalled();
    expect(setApproveWritesMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("approvePlan leaves plan mode alone when it was already off", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    mockConversations = [{ id: "conv-A", planMode: false }];

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();

    expect(setPlanModeMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("approvePlan is idempotent — a repeat click can never double-send the execute turn", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().approvePlan("conv-A", "Plan approved — implement it now.");
    useAgentPlanStore.getState().approvePlan("conv-A", "Plan approved — implement it now.");
    await flushAsync();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("approvePlan no-ops when the conversation was already approved (persisted state)", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      plan: new Map([["conv-A", [makePlanItem()]]]),
      planApproved: new Map([["conv-A", true]]),
    });

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("resetPlanApproval re-arms approval so a fresh planning round can approve again", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    useAgentPlanStore.getState().resetPlanApproval("conv-A");
    expect(useAgentPlanStore.getState().planApproved.has("conv-A")).toBe(false);

    useAgentPlanStore.getState().approvePlan("conv-A");
    await flushAsync();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("clearConversation drops every field for that conversation", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      plan: new Map([["conv-A", [makePlanItem()]]]),
      planApproved: new Map([["conv-A", true]]),
    });

    useAgentPlanStore.getState().clearConversation("conv-A");

    expect(useAgentPlanStore.getState().plan.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().planApproved.has("conv-A")).toBe(false);
  });

  it("isolates state across conversations — clearing one leaves the other intact", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().setPlan("conv-A", [makePlanItem({ id: "a" })]);
    useAgentPlanStore.getState().setPlan("conv-B", [makePlanItem({ id: "b" })]);
    useAgentPlanStore.getState().approvePlan("conv-B");
    await flushAsync();

    useAgentPlanStore.getState().clearConversation("conv-A");

    expect(useAgentPlanStore.getState().plan.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().plan.get("conv-B")).toEqual([
      makePlanItem({ id: "b" }),
    ]);
    expect(useAgentPlanStore.getState().planApproved.get("conv-B")).toBe(true);
  });

  it("hydrateConversation rebuilds plan + planApproved from a persisted payload", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().hydrateConversation("conv-A", {
      plan: [makePlanItem()],
      planApproved: true,
    });

    expect(useAgentPlanStore.getState().plan.get("conv-A")?.length).toBe(1);
    expect(useAgentPlanStore.getState().planApproved.get("conv-A")).toBe(true);
  });

  it("getPlanApproved returns false when nothing is recorded for the conversation", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    expect(useAgentPlanStore.getState().getPlanApproved("unknown-conv")).toBe(false);
  });
});
