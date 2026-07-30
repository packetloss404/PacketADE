/**
 * D2 / P0-3 — one verb for the Markdown/Plan preview.
 *
 * Before this module, "Hide preview pane" (header overflow menu) and "Collapse
 * preview" (the embedded pane's own button) did different things to different
 * stores, and a later Markdown open could update a pane nobody could see.
 *
 * Every producer and consumer now goes through these four functions:
 *   - `openMarkdownPreview` / `openPlanPreview` — set the conversation-scoped
 *     target AND reveal the dock's Preview panel;
 *   - `hidePreview` — the ONE hide verb, used by both the menu and the pane's
 *     close button (they are literally the same call);
 *   - `isPreviewVisible` — the ONE truth for "is the preview showing".
 */
import {
  usePreviewPaneStore,
  type PreviewPaneTab,
} from "@/stores/previewPaneStore";
import {
  isPanelVisible,
  useRightDockStore,
  type DockSurface,
  type DockSurfaceState,
} from "@/stores/rightDockStore";

/** The preview lives in the Agents surface dock. */
export const PREVIEW_SURFACE: DockSurface = "agents";

export function openMarkdownPreview(conversationId: string, path: string): void {
  usePreviewPaneStore.getState().openMarkdown(conversationId, path);
  useRightDockStore.getState().openPanel(PREVIEW_SURFACE, "preview");
}

export function openPlanPreview(
  conversationId: string,
  content: string,
  title = "Agent plan",
): void {
  usePreviewPaneStore.getState().openPlan(conversationId, content, title);
  useRightDockStore.getState().openPanel(PREVIEW_SURFACE, "preview");
}

/**
 * The ONE hide verb. Returns the dock to the Inspector panel (rather than
 * collapsing the whole dock) so "Hide preview" and the pane's own close button
 * are indistinguishable in behaviour.
 */
export function hidePreview(): void {
  const dock = useRightDockStore.getState();
  if (dock.surfaces[PREVIEW_SURFACE].activePanel !== "preview") return;
  dock.setActivePanel(PREVIEW_SURFACE, "inspector");
}

export function previewVisible(
  surfaces: Record<DockSurface, DockSurfaceState>,
): boolean {
  return isPanelVisible(surfaces, PREVIEW_SURFACE, "preview");
}

/** Hook form for components. */
export function useIsPreviewVisible(): boolean {
  return useRightDockStore((s) => previewVisible(s.surfaces));
}

export function setPreviewTab(conversationId: string, tab: PreviewPaneTab): void {
  usePreviewPaneStore.getState().setActiveTab(conversationId, tab);
}
