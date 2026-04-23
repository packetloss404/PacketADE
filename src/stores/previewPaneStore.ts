import { create } from "zustand";

export type PreviewPaneTab = "markdown" | "browser" | "plan";

interface PreviewPaneState {
  open: boolean;
  activeTab: PreviewPaneTab;
  markdownPath: string | null;
  planTitle: string;
  planContent: string;
  browserUrl: string;
  openMarkdown: (path: string) => void;
  openPlan: (content: string, title?: string) => void;
  openBrowser: (url?: string) => void;
  setActiveTab: (tab: PreviewPaneTab) => void;
  setBrowserUrl: (url: string) => void;
  toggle: () => void;
  close: () => void;
}

export const usePreviewPaneStore = create<PreviewPaneState>((set) => ({
  open: false,
  activeTab: "markdown",
  markdownPath: null,
  planTitle: "Agent plan",
  planContent: "",
  browserUrl: "",
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
  openBrowser: (url) =>
    set((state) => ({
      open: true,
      activeTab: "browser",
      browserUrl: url ?? state.browserUrl,
    })),
  setActiveTab: (tab) => set({ activeTab: tab, open: true }),
  setBrowserUrl: (url) => set({ browserUrl: url }),
  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
}));
