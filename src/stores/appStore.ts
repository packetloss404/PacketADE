import { create } from "zustand";

export type CoreView = "welcome" | "issues" | "flights" | "history" | "tools" | "github" | "memory" | "deploy" | "review_queue" | "workspace" | "agents" | "cost_dashboard" | "dictation";
export type AppView = CoreView | `mod:${string}`;

export function isModuleView(view: AppView): boolean {
  return view.startsWith("mod:");
}

export function getModuleId(view: AppView): string | null {
  return view.startsWith("mod:") ? view.slice(4) : null;
}

export function moduleViewId(id: string): AppView {
  return `mod:${id}` as AppView;
}

/** v0.8-H: deep-link filter applied to MemoryView when navigated to from
 * another surface (e.g. the FlightsView "N patterns extracted" chip).
 * Set via {@link AppStore.openMemoryView} and cleared either explicitly
 * (the consumer clicks Clear) or implicitly (next time it's set). */
export interface MemoryViewFilter {
  /** Restrict MemoryView to events/patterns tied to a specific flight. */
  flightId?: string;
  /** Restrict MemoryView to a single project's events/patterns. */
  projectPath?: string;
}

interface AppStore {
  initialized: boolean;
  activeView: AppView;
  gitBranch: string | null;
  claudeVersion: string | null;
  isMaximized: boolean;
  commandPaletteOpen: boolean;
  theme: "dark" | "light";
  /** v0.8-H: optional filter applied the next time MemoryView mounts.
   * Consumed by `MemoryView` on mount and cleared after read. */
  memoryViewFilter: MemoryViewFilter | null;
  setInitialized: (initialized: boolean) => void;
  setActiveView: (view: AppView) => void;
  setGitBranch: (branch: string | null) => void;
  setClaudeVersion: (version: string | null) => void;
  setIsMaximized: (maximized: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
  /** v0.8-H: switch to MemoryView with an optional filter. The filter
   * lives in store state so the receiving view can react to it without
   * a separate routing layer. */
  openMemoryView: (filter?: MemoryViewFilter) => void;
  clearMemoryViewFilter: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  initialized: false,
  activeView: "welcome",
  gitBranch: null,
  claudeVersion: null,
  isMaximized: false,
  commandPaletteOpen: false,
  theme: "dark",
  memoryViewFilter: null,
  setInitialized: (initialized) => set({ initialized }),
  setActiveView: (view) => set({ activeView: view }),
  setGitBranch: (branch) => set({ gitBranch: branch }),
  setClaudeVersion: (version) => set({ claudeVersion: version }),
  setIsMaximized: (maximized) => set({ isMaximized: maximized }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setTheme: (theme) => set({ theme }),
  openMemoryView: (filter) =>
    set({ activeView: "memory", memoryViewFilter: filter ?? null }),
  clearMemoryViewFilter: () => set({ memoryViewFilter: null }),
}));
