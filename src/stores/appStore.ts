import { create } from "zustand";
import type { SettingsTarget } from "@/types/settings";

export type CoreView =
  | "welcome"
  | "workspace"
  | "agents"
  | "issues"
  | "flights"
  | "history"
  | "tools"
  | "github"
  | "memory"
  | "cost_dashboard"
  | "dictation";
export type AppView = CoreView | `mod:${string}`;

/**
 * View-normalization chokepoint for hydrated UI state. The WA1
 * Workspace/Agents split restores `"agents"` as a real same-window view, so a
 * persisted Agents selection must survive instead of being redirected to
 * Workspace.
 */
export function normalizeView(view: AppView): AppView {
  return view;
}

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
  settingsTarget: SettingsTarget | null;
  theme: "dark" | "light";
  /** v0.8-H: optional filter applied the next time MemoryView mounts.
   * Consumed by `MemoryView` on mount and cleared after read. */
  memoryViewFilter: MemoryViewFilter | null;
  /**
   * Tile program: WorkspaceView's GitDashboard slide-out open-state, lifted out
   * of local component state so the ReviewBar "Finish → Commit…" CTA (deep in
   * the tile tree) can open the ONE endings surface for a conversation.
   */
  gitPanelOpen: boolean;
  /**
   * When set, the open GitDashboard mounts the WorktreeLifecycleBar scoped to
   * this conversation's worktree (Merge back / Create PR / Discard / Keep).
   * `null` ⇒ the plain workspace git view (opened via the header toggle).
   */
  gitPanelConversationId: string | null;
  /** Workspace that owns the current Git-ending projection. This replaces the
   * old requirement that a conversation pane be attached to prove scope. */
  gitPanelWorkspaceId: string | null;
  setInitialized: (initialized: boolean) => void;
  setActiveView: (view: AppView) => void;
  setGitBranch: (branch: string | null) => void;
  setClaudeVersion: (version: string | null) => void;
  setIsMaximized: (maximized: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  openSettings: (target?: SettingsTarget) => void;
  clearSettingsTarget: () => void;
  setTheme: (theme: "dark" | "light") => void;
  /** Header git toggle: open the plain workspace git view (no lifecycle bar) or
   *  close the panel. Always clears any conversation scope. */
  setGitPanelOpen: (open: boolean) => void;
  /** ReviewBar "Finish → Commit…": open the git panel scoped to a conversation
   *  so its WorktreeLifecycleBar (the endings loop) is directly visible. */
  openGitPanelForConversation: (conversationId: string, workspaceId: string) => void;
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
  settingsTarget: null,
  theme: "dark",
  memoryViewFilter: null,
  gitPanelOpen: false,
  gitPanelConversationId: null,
  gitPanelWorkspaceId: null,
  setInitialized: (initialized) => set({ initialized }),
  setActiveView: (view) => set({ activeView: normalizeView(view) }),
  setGitBranch: (branch) => set({ gitBranch: branch }),
  setClaudeVersion: (version) => set({ claudeVersion: version }),
  setIsMaximized: (maximized) => set({ isMaximized: maximized }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  openSettings: (target) => set({ activeView: "tools", settingsTarget: target ?? null }),
  clearSettingsTarget: () => set({ settingsTarget: null }),
  setTheme: (theme) => set({ theme }),
  setGitPanelOpen: (open) =>
    set({
      gitPanelOpen: open,
      gitPanelConversationId: null,
      gitPanelWorkspaceId: null,
    }),
  openGitPanelForConversation: (conversationId, workspaceId) =>
    set({
      gitPanelOpen: true,
      gitPanelConversationId: conversationId,
      gitPanelWorkspaceId: workspaceId,
    }),
  openMemoryView: (filter) => set({ activeView: "memory", memoryViewFilter: filter ?? null }),
  clearMemoryViewFilter: () => set({ memoryViewFilter: null }),
}));
