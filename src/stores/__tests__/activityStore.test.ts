import { describe, it, expect, beforeEach } from "vitest";
import { useActivityStore, type PaneActivity } from "../activityStore";

const store = () => useActivityStore.getState();

function makeActivity(overrides: Partial<PaneActivity> = {}): PaneActivity {
  return {
    currentTool: null,
    currentFile: null,
    agentState: "idle",
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("activityStore", () => {
  beforeEach(() => {
    useActivityStore.setState({ activities: {} });
  });

  it("setActivity stores activity for a pane", () => {
    store().setActivity("pane_1", makeActivity({ agentState: "thinking" }));
    expect(store().activities.pane_1.agentState).toBe("thinking");
  });

  it("setActivity overwrites previous activity for same pane", () => {
    store().setActivity("pane_1", makeActivity({ agentState: "thinking" }));
    store().setActivity("pane_1", makeActivity({ agentState: "responding", currentTool: "Edit" }));
    expect(store().activities.pane_1.agentState).toBe("responding");
    expect(store().activities.pane_1.currentTool).toBe("Edit");
  });

  it("setActivity for one pane does not affect others", () => {
    store().setActivity("pane_1", makeActivity({ agentState: "thinking" }));
    store().setActivity("pane_2", makeActivity({ agentState: "tool_use" }));
    expect(store().activities.pane_1.agentState).toBe("thinking");
    expect(store().activities.pane_2.agentState).toBe("tool_use");
  });

  it("getActivity returns the activity for a pane", () => {
    const activity = makeActivity({ currentFile: "foo.ts" });
    store().setActivity("pane_1", activity);
    expect(store().getActivity("pane_1")?.currentFile).toBe("foo.ts");
  });

  it("getActivity returns undefined for unknown pane", () => {
    expect(store().getActivity("nope")).toBeUndefined();
  });

  it("clearActivity removes the activity for a pane", () => {
    store().setActivity("pane_1", makeActivity());
    store().setActivity("pane_2", makeActivity());
    store().clearActivity("pane_1");
    expect(store().activities.pane_1).toBeUndefined();
    expect(store().activities.pane_2).toBeDefined();
  });

  it("clearActivity is a no-op for unknown pane", () => {
    store().setActivity("pane_1", makeActivity());
    expect(() => store().clearActivity("nope")).not.toThrow();
    expect(store().activities.pane_1).toBeDefined();
  });
});
