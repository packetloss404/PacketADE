import { create } from "zustand";
import { useLayoutStore } from "@/stores/layoutStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useProfileStore } from "@/stores/profileStore";

export type CoreView = "welcome" | "claude" | "codex" | "gemini" | "opencode" | "issues" | "missions" | "history" | "tools" | "github" | "memory" | "deploy" | "review_queue" | "workspace" | "agents" | "cost_dashboard" | "dictation";
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

interface AppStore {
  initialized: boolean;
  activeView: AppView;
  gitBranch: string | null;
  claudeVersion: string | null;
  isMaximized: boolean;
  commandPaletteOpen: boolean;
  theme: "dark" | "light";
  setInitialized: (initialized: boolean) => void;
  setActiveView: (view: AppView) => void;
  setGitBranch: (branch: string | null) => void;
  setClaudeVersion: (version: string | null) => void;
  setIsMaximized: (maximized: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
  quickStartSession: (cli?: "claude" | "codex" | "gemini" | "opencode") => void;
}

export const useAppStore = create<AppStore>((set) => ({
  initialized: false,
  activeView: "welcome",
  gitBranch: null,
  claudeVersion: null,
  isMaximized: false,
  commandPaletteOpen: false,
  theme: "dark",
  setInitialized: (initialized) => set({ initialized }),
  setActiveView: (view) => set({ activeView: view }),
  setGitBranch: (branch) => set({ gitBranch: branch }),
  setClaudeVersion: (version) => set({ claudeVersion: version }),
  setIsMaximized: (maximized) => set({ isMaximized: maximized }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setTheme: (theme) => set({ theme }),
  quickStartSession: async (cli = "claude") => {
    const profileStore = useProfileStore.getState();
    const memoryStore = useMemoryStore.getState();
    const layoutStore = useLayoutStore.getState();

    const profile = profileStore.activeProfileId
      ? profileStore.profiles.find((p: { id: string }) => p.id === profileStore.activeProfileId)
      : null;

    const args: string[] = [];
    if (profile?.defaultModel) {
      args.push("--model", profile.defaultModel);
    }

    let prompt = "";
    if (profile?.systemPrompt) {
      prompt += profile.systemPrompt + "\n\n";
    }

    const memoryContext = memoryStore.getContextForSession(layoutStore.projectPath);
    if (memoryContext.trim()) {
      prompt += memoryContext + "\n\n";
    }

    set({ activeView: cli });
    layoutStore.addPane({
      cliCommand: cli,
      cliArgs: args.length > 0 ? args : undefined,
      initialPrompt: prompt.trim() || undefined,
    });
  },
}));
