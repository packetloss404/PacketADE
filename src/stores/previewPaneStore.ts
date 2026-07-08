import { create } from "zustand";

export type PreviewPaneTab = "markdown" | "plan";

interface PreviewPaneState {
  open: boolean;
  activeTab: PreviewPaneTab;
  markdownPath: string | null;
  planTitle: string;
  planContent: string;
  openMarkdown: (path: string) => void;
  openPlan: (content: string, title?: string) => void;
  setActiveTab: (tab: PreviewPaneTab) => void;
  toggle: () => void;
  close: () => void;
}

export const usePreviewPaneStore = create<PreviewPaneState>((set) => ({
  open: false,
  activeTab: "markdown",
  markdownPath: null,
  planTitle: "Agent plan",
  planContent: "",
  openMarkdown: (path) =>
    set({
      open: true,
      activeTab: "markdown",
      markdownPath: path,
    }),
  openPlan: (content, title = "Agent plan") =>
    set({
      open: true,
      activeTab: "plan",
      planTitle: title,
      planContent: content,
    }),
  setActiveTab: (tab) => set({ activeTab: tab, open: true }),
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
}));
