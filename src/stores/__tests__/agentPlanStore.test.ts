import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPlanItem } from "@/types/agent-conversation";

const requestConversationSaveMock = vi.fn();
const sendMessageMock = vi.fn();
const setPlanModeMock = vi.fn().mockResolvedValue(undefined);

// agentPlanStore lazily imports agentTaskStore inside its actions to avoid a
// circular-import deadlock. Stub the whole module so we can observe the
// debounced-save + synthesized-user-turn side-effects without dragging in
// the real conversation store.
vi.mock("@/stores/agentTaskStore", () => ({
  requestConversationSave: (...args: unknown[]) => requestConversationSaveMock(...args),
  useAgentTaskStore: {
    getState: vi.fn(() => ({
      conversations: [],
      sendMessage: (...args: unknown[]) => sendMessageMock(...args),
      setPlanMode: (...args: unknown[]) => setPlanModeMock(...args),
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

describe("agentPlanStore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      spec: new Map(),
      specStage: new Map(),
      plan: new Map(),
      planApproved: new Map(),
    });
  });

  it("setSpec stores the criteria with status=draft and seeds the spec stage", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().setSpec("conv-A", ["criterion 1", "criterion 2"]);

    const stored = useAgentPlanStore.getState().spec.get("conv-A");
    expect(stored?.criteria).toEqual(["criterion 1", "criterion 2"]);
    expect(stored?.status).toBe("draft");
    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBe("spec");
  });

  it("setSpec preserves an explicit stage that was already set", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      spec: new Map(),
      specStage: new Map([["conv-A", "plan"]]),
      plan: new Map(),
      planApproved: new Map(),
    });

    useAgentPlanStore.getState().setSpec("conv-A", ["fresh criterion"]);

    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBe("plan");
  });

  it("setSpecStage records the requested stage transition", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().setSpecStage("conv-A", "plan");
    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBe("plan");

    useAgentPlanStore.getState().setSpecStage("conv-A", "code");
    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBe("code");
  });

  it("setPlan stores the plan array", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    const items = [
      makePlanItem({ id: "a", content: "Read the file" }),
      makePlanItem({ id: "b", content: "Edit the file", status: "in_progress" }),
    ];

    useAgentPlanStore.getState().setPlan("conv-A", items);

    expect(useAgentPlanStore.getState().plan.get("conv-A")).toEqual(items);
  });

  it("approvePlan flips planApproved to true and advances stage to code", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      spec: new Map(),
      specStage: new Map([["conv-A", "plan"]]),
      plan: new Map([["conv-A", [makePlanItem()]]]),
      planApproved: new Map(),
    });

    useAgentPlanStore.getState().approvePlan("conv-A");

    expect(useAgentPlanStore.getState().planApproved.get("conv-A")).toBe(true);
    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBe("code");
  });

  it("approvePlan is idempotent — second call doesn't fire side effects again", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      spec: new Map(),
      specStage: new Map([["conv-A", "plan"]]),
      plan: new Map([["conv-A", [makePlanItem()]]]),
      planApproved: new Map([["conv-A", true]]),
    });

    useAgentPlanStore.getState().approvePlan("conv-A");

    // Already approved → no synthesized user-turn dispatched.
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("clearConversation drops every field for that conversation", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");
    useAgentPlanStore.setState({
      spec: new Map([
        ["conv-A", { criteria: ["x"], status: "draft", updatedAt: 1 }],
      ]),
      specStage: new Map([["conv-A", "plan"]]),
      plan: new Map([["conv-A", [makePlanItem()]]]),
      planApproved: new Map([["conv-A", true]]),
    });

    useAgentPlanStore.getState().clearConversation("conv-A");

    expect(useAgentPlanStore.getState().spec.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().specStage.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().plan.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().planApproved.has("conv-A")).toBe(false);
  });

  it("isolates state across conversations — clearing one leaves the other intact", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().setSpec("conv-A", ["criterion A"]);
    useAgentPlanStore.getState().setSpec("conv-B", ["criterion B"]);
    useAgentPlanStore.getState().setSpecStage("conv-A", "plan");
    useAgentPlanStore.getState().setSpecStage("conv-B", "code");
    useAgentPlanStore.getState().setPlan("conv-A", [makePlanItem({ id: "a" })]);
    useAgentPlanStore.getState().setPlan("conv-B", [makePlanItem({ id: "b" })]);

    useAgentPlanStore.getState().clearConversation("conv-A");

    expect(useAgentPlanStore.getState().spec.has("conv-A")).toBe(false);
    expect(useAgentPlanStore.getState().spec.get("conv-B")?.criteria).toEqual(["criterion B"]);
    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBeUndefined();
    expect(useAgentPlanStore.getState().specStage.get("conv-B")).toBe("code");
    expect(useAgentPlanStore.getState().plan.get("conv-B")).toEqual([
      makePlanItem({ id: "b" }),
    ]);
  });

  it("hydrateConversation rebuilds all four fields from a persisted payload", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    useAgentPlanStore.getState().hydrateConversation("conv-A", {
      spec: { criteria: ["a"], status: "approved", updatedAt: 1234 },
      specStage: "code",
      plan: [makePlanItem()],
      planApproved: true,
    });

    expect(useAgentPlanStore.getState().spec.get("conv-A")?.status).toBe("approved");
    expect(useAgentPlanStore.getState().specStage.get("conv-A")).toBe("code");
    expect(useAgentPlanStore.getState().plan.get("conv-A")?.length).toBe(1);
    expect(useAgentPlanStore.getState().planApproved.get("conv-A")).toBe(true);
  });

  it("getPlanApproved returns false when nothing is recorded for the conversation", async () => {
    const { useAgentPlanStore } = await import("@/stores/agentPlanStore");

    expect(useAgentPlanStore.getState().getPlanApproved("unknown-conv")).toBe(false);
  });
});
