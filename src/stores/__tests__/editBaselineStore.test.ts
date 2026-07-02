import { beforeEach, describe, expect, it } from "vitest";
import { useEditBaselineStore } from "@/stores/editBaselineStore";

/**
 * P1-7: recorded pre-edit baselines. First-wins per (conversation, path) is
 * the load-bearing rule — the first capture is the true pre-turn content;
 * later captures see intermediate (or post-apply) states and must never
 * overwrite it.
 */
describe("editBaselineStore", () => {
  beforeEach(() => {
    useEditBaselineStore.setState({
      byConversation: new Map(),
      byToolCall: new Map(),
    });
  });

  it("records and returns a baseline per conversation + path", () => {
    const s = useEditBaselineStore.getState();
    s.recordBaseline("conv-1", "src/a.ts", "original\n", "tc-1");
    expect(
      useEditBaselineStore.getState().getBaseline("conv-1", "src/a.ts"),
    ).toEqual({ content: "original\n" });
    // Other conversations / paths are unaffected.
    expect(
      useEditBaselineStore.getState().getBaseline("conv-2", "src/a.ts"),
    ).toBeUndefined();
    expect(
      useEditBaselineStore.getState().getBaseline("conv-1", "src/b.ts"),
    ).toBeUndefined();
  });

  it("first-wins per path: a later (post-apply) capture never overwrites", () => {
    const s = useEditBaselineStore.getState();
    s.recordBaseline("conv-1", "src/a.ts", "true before", "tc-1");
    s.recordBaseline("conv-1", "src/a.ts", "post-apply content", "tc-2");
    expect(
      useEditBaselineStore.getState().getBaseline("conv-1", "src/a.ts"),
    ).toEqual({ content: "true before" });
    // But the per-call baseline for the second call IS recorded.
    expect(
      useEditBaselineStore.getState().getToolCallBaseline("tc-2"),
    ).toEqual({
      conversationId: "conv-1",
      path: "src/a.ts",
      content: "post-apply content",
    });
  });

  it("distinguishes 'new file' (null) from 'never recorded' (undefined)", () => {
    const s = useEditBaselineStore.getState();
    s.recordBaseline("conv-1", "src/new.ts", null, "tc-1");
    expect(
      useEditBaselineStore.getState().getBaseline("conv-1", "src/new.ts"),
    ).toEqual({ content: null });
    expect(
      useEditBaselineStore.getState().getBaseline("conv-1", "src/other.ts"),
    ).toBeUndefined();
  });

  it("records per-tool-call baselines independently of the path index", () => {
    const s = useEditBaselineStore.getState();
    s.recordBaseline("conv-1", "src/a.ts", "v1", "tc-1");
    s.recordBaseline("conv-1", "src/a.ts", "v2", "tc-2");
    expect(useEditBaselineStore.getState().getToolCallBaseline("tc-1")).toEqual(
      { conversationId: "conv-1", path: "src/a.ts", content: "v1" },
    );
    expect(useEditBaselineStore.getState().getToolCallBaseline("tc-2")).toEqual(
      { conversationId: "conv-1", path: "src/a.ts", content: "v2" },
    );
    // Re-recording the same tool call is a no-op (first-wins there too).
    s.recordBaseline("conv-1", "src/a.ts", "v3", "tc-1");
    expect(
      useEditBaselineStore.getState().getToolCallBaseline("tc-1")?.content,
    ).toBe("v1");
  });

  it("works without a toolCallId (path baseline only)", () => {
    useEditBaselineStore
      .getState()
      .recordBaseline("conv-1", "src/a.ts", "before");
    expect(
      useEditBaselineStore.getState().getBaseline("conv-1", "src/a.ts"),
    ).toEqual({ content: "before" });
  });

  it("clearConversation drops both indexes for that conversation only", () => {
    const s = useEditBaselineStore.getState();
    s.recordBaseline("conv-1", "src/a.ts", "a", "tc-1");
    s.recordBaseline("conv-2", "src/b.ts", "b", "tc-2");
    useEditBaselineStore.getState().clearConversation("conv-1");
    const after = useEditBaselineStore.getState();
    expect(after.getBaseline("conv-1", "src/a.ts")).toBeUndefined();
    expect(after.getToolCallBaseline("tc-1")).toBeUndefined();
    expect(after.getBaseline("conv-2", "src/b.ts")).toEqual({ content: "b" });
    expect(after.getToolCallBaseline("tc-2")?.content).toBe("b");
  });
});
