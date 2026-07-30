/**
 * D2 / P0-3 — conversation-scoped preview target.
 *
 * The old store held `{ open, activeTab, markdownPath, … }` with no
 * conversation identity, so a relative Markdown path opened for conversation A
 * was resolved against conversation B's project once the selection changed. It
 * also owned VISIBILITY, which competed with the inspector's local tab state:
 * "Hide preview pane" flipped `open` without changing the visible tab, and the
 * embedded close button changed the tab without touching `open`.
 *
 * Now this store owns only WHAT is previewed, stamped with the conversation
 * that asked for it. Visibility belongs to `rightDockStore` (the preview is a
 * dock panel), and Hide/Close are one verb — see `lib/previewDock.ts`.
 */
import { create } from "zustand";

export type PreviewPaneTab = "markdown" | "plan";

export interface PreviewTarget {
  /** The conversation that opened this preview. Never resolved against any
   *  other conversation's project path. */
  conversationId: string;
  activeTab: PreviewPaneTab;
  markdownPath: string | null;
  planTitle: string;
  planContent: string;
}

interface PreviewPaneState {
  target: PreviewTarget | null;
  openMarkdown: (conversationId: string, path: string) => void;
  openPlan: (conversationId: string, content: string, title?: string) => void;
  setActiveTab: (conversationId: string, tab: PreviewPaneTab) => void;
  /** Drop the target entirely (conversation closed / archived). */
  clear: () => void;
}

function blank(conversationId: string): PreviewTarget {
  return {
    conversationId,
    activeTab: "markdown",
    markdownPath: null,
    planTitle: "Agent plan",
    planContent: "",
  };
}

/** The target, but only when it belongs to `conversationId`. */
export function previewTargetFor(
  target: PreviewTarget | null,
  conversationId: string,
): PreviewTarget | null {
  return target && target.conversationId === conversationId ? target : null;
}

export const usePreviewPaneStore = create<PreviewPaneState>((set) => ({
  target: null,

  openMarkdown: (conversationId, path) =>
    set((state) => {
      const base =
        state.target?.conversationId === conversationId
          ? state.target
          : blank(conversationId);
      return { target: { ...base, activeTab: "markdown", markdownPath: path } };
    }),

  openPlan: (conversationId, content, title = "Agent plan") =>
    set((state) => {
      const base =
        state.target?.conversationId === conversationId
          ? state.target
          : blank(conversationId);
      return {
        target: {
          ...base,
          activeTab: "plan",
          planTitle: title,
          planContent: content,
        },
      };
    }),

  setActiveTab: (conversationId, tab) =>
    set((state) => {
      const base =
        state.target?.conversationId === conversationId
          ? state.target
          : blank(conversationId);
      return { target: { ...base, activeTab: tab } };
    }),

  clear: () => set({ target: null }),
}));
