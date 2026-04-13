import { loadPersistedState, getCwd, saveUiSlice } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useAgentStore } from "@/stores/agentStore";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useMemoryStore } from "@/stores/memoryStore";
import type { AppView } from "@/stores/appStore";

/**
 * App initialization — called once on mount.
 * Loads persisted state from the Rust backend and hydrates all stores.
 */
export async function initializeApp(): Promise<void> {
  try {
    const state = await loadPersistedState();

    // Hydrate stores in parallel (each accepts the pre-loaded state to avoid extra round-trips)
    // Workspace + Memory stores — synchronous hydration
    useWorkspaceStore.getState().hydrateFromBackend(state.workspaces);
    useMemoryStore.getState().hydrateFromBackend(state);
    await Promise.allSettled([
      useFlightStore.getState().hydrateFromBackend(state),
      useAgentStore.getState().hydrateFromBackend(state),
      useOrchestrationStore.getState().hydrateFromBackend(state),
    ]);

    // Restore UI state
    if (state.ui.theme === "dark" || state.ui.theme === "light") {
      useAppStore.getState().setTheme(state.ui.theme);
    }

    const savedView = state.ui.selectedView as AppView | null;
    if (savedView) {
      useAppStore.getState().setActiveView(savedView);
    }

    // Restore project path: backend settings > localStorage > CWD
    const backendPath = state.settings.projectPath;
    const localPath = localStorage.getItem("packetcode:project-path");
    const projectPath = backendPath || localPath || null;

    if (projectPath) {
      useLayoutStore.getState().setProjectPath(projectPath);
    } else {
      try {
        const cwd = await getCwd();
        if (cwd) useLayoutStore.getState().setProjectPath(cwd);
      } catch {
        // no CWD available
      }
    }
  } catch {
    // Backend unavailable — fall back to localStorage defaults
    const localPath = localStorage.getItem("packetcode:project-path");
    if (localPath) {
      useLayoutStore.getState().setProjectPath(localPath);
    } else {
      try {
        const cwd = await getCwd();
        if (cwd) useLayoutStore.getState().setProjectPath(cwd);
      } catch {
        // no CWD available
      }
    }
  }

  // Mark app as initialized
  useAppStore.getState().setInitialized(true);

  // Kick CLI detection in the background — surfaces installed status to the
  // onboarding flow and the workspace creation modal. Must not block startup.
  void useAgentStore.getState().detectInstalled();
}

/**
 * Persist the current UI state to the backend (debounced).
 */
let uiPersistTimer: ReturnType<typeof setTimeout> | null = null;

export function persistUiState() {
  if (uiPersistTimer) clearTimeout(uiPersistTimer);
  uiPersistTimer = setTimeout(() => {
    const { activeView, theme } = useAppStore.getState();
    saveUiSlice({
      selectedView: activeView,
      selectedFlightId: null,
      theme,
    }).catch(() => {});
  }, 1000);
}
