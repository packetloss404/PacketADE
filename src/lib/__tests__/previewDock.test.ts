/**
 * D2 / P0-3 — preview ownership: conversation scoping + one Hide verb.
 *
 * Before this, `previewPaneStore` had no conversation id (so a relative path
 * opened for conversation A could resolve against conversation B's project),
 * and "Hide preview pane" / the embedded close button mutated different state
 * so the two could disagree.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  hidePreview,
  openMarkdownPreview,
  openPlanPreview,
  previewVisible,
  setPreviewTab,
} from "@/lib/previewDock";
import {
  previewTargetFor,
  usePreviewPaneStore,
} from "@/stores/previewPaneStore";
import { useRightDockStore } from "@/stores/rightDockStore";

function dockSurfaces() {
  return useRightDockStore.getState().surfaces;
}

describe("preview dock ownership", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.getState().reset();
    usePreviewPaneStore.getState().clear();
  });

  it("stamps the opening conversation on the target", () => {
    openMarkdownPreview("conv-a", "docs/plan.md");
    const target = usePreviewPaneStore.getState().target!;
    expect(target.conversationId).toBe("conv-a");
    expect(target.markdownPath).toBe("docs/plan.md");
    expect(target.activeTab).toBe("markdown");
  });

  it("never hands conversation A's target to conversation B", () => {
    openMarkdownPreview("conv-a", "docs/plan.md");
    const state = usePreviewPaneStore.getState().target;
    expect(previewTargetFor(state, "conv-a")?.markdownPath).toBe("docs/plan.md");
    // The relative path must NOT resolve against another conversation.
    expect(previewTargetFor(state, "conv-b")).toBeNull();
  });

  it("replaces the target when a different conversation opens a preview", () => {
    openMarkdownPreview("conv-a", "a.md");
    openPlanPreview("conv-b", "# B plan");
    const target = usePreviewPaneStore.getState().target!;
    expect(target.conversationId).toBe("conv-b");
    expect(target.planContent).toBe("# B plan");
    // conv-a's stale markdown path is not carried across conversations.
    expect(previewTargetFor(target, "conv-a")).toBeNull();
  });

  it("reveals the Preview dock panel when a target is opened", () => {
    expect(previewVisible(dockSurfaces())).toBe(false);
    openMarkdownPreview("conv-a", "a.md");
    expect(previewVisible(dockSurfaces())).toBe(true);
  });

  it("Hide and Close are the SAME verb with the same result", () => {
    openMarkdownPreview("conv-a", "a.md");

    // The header overflow menu's "Hide preview pane"…
    hidePreview();
    expect(previewVisible(dockSurfaces())).toBe(false);
    expect(dockSurfaces().agents.activePanel).toBe("inspector");
    // …still expanded, just showing another panel — nothing is left invisibly
    // "open" the way the old `previewPaneStore.open` flag was.
    expect(dockSurfaces().agents.expanded).toBe(true);

    // …and the embedded pane's own close button calls the identical function.
    openMarkdownPreview("conv-a", "a.md");
    expect(previewVisible(dockSurfaces())).toBe(true);
    hidePreview();
    expect(previewVisible(dockSurfaces())).toBe(false);
  });

  it("hide is a no-op when the dock has already moved to another panel", () => {
    openMarkdownPreview("conv-a", "a.md");
    useRightDockStore.getState().openPanel("agents", "diff");
    hidePreview();
    expect(dockSurfaces().agents.activePanel).toBe("diff");
  });

  it("re-opening after a hide shows the preview again (no invisible open state)", () => {
    openMarkdownPreview("conv-a", "a.md");
    hidePreview();
    openMarkdownPreview("conv-a", "b.md");
    expect(previewVisible(dockSurfaces())).toBe(true);
    expect(usePreviewPaneStore.getState().target?.markdownPath).toBe("b.md");
  });

  it("keeps the tab switch scoped to its conversation", () => {
    openMarkdownPreview("conv-a", "a.md");
    setPreviewTab("conv-a", "plan");
    expect(usePreviewPaneStore.getState().target?.activeTab).toBe("plan");
    // A tab switch requested by a different conversation takes ownership
    // rather than silently retargeting conv-a's file.
    setPreviewTab("conv-b", "markdown");
    const target = usePreviewPaneStore.getState().target!;
    expect(target.conversationId).toBe("conv-b");
    expect(target.markdownPath).toBeNull();
  });
});
