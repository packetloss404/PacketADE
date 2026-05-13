import { loadPersistedState, getCwd, saveUiSlice } from "@/lib/tauri";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useAgentStore } from "@/stores/agentStore";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useOrchestrationStore } from "@/stores/orchestrationStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useServerStore } from "@/stores/serverStore";

/**
 * App initialization — called once on mount.
 * Loads persisted state from the Rust backend and hydrates all stores.
 */
export async function initializeApp(): Promise<void> {
  try {
    const state = await loadPersistedState();

    // Synchronous hydrations — these stores feed the welcome screen and
    // global chrome; render-blocking by design.
    useWorkspaceStore.getState().hydrateFromBackend(state.workspaces);
    useMemoryStore.getState().hydrateFromBackend(state);
    useServerStore.getState().hydrateFromBackend(state.servers);

    // Apply theme + force welcome view before doing anything else, so the
    // first paint of the post-bootstrap UI is correctly themed.
    if (state.ui.theme === "dark" || state.ui.theme === "light") {
      useAppStore.getState().setTheme(state.ui.theme);
    }
    useAppStore.getState().setActiveView("welcome");

    // Restore project path: backend settings > localStorage > CWD
    const backendPath = state.settings.projectPath;
    const localPath = localStorage.getItem("packetade:project-path");
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

    // Mark app as initialized so UI persistence can begin.
    useAppStore.getState().setInitialized(true);

    // Heavy stores hydrate in the background — welcome doesn't need them,
    // and they don't make additional backend calls when given pre-loaded
    // state, so this is really just a clarity/intent signal.
    void useFlightStore.getState().hydrateFromBackend(state).catch(() => undefined);
    void useAgentStore.getState().hydrateFromBackend(state).catch(() => undefined);
    void useOrchestrationStore.getState().hydrateFromBackend(state).catch(() => undefined);
  } catch {
    // Backend unavailable — fall back to localStorage defaults.
    const localPath = localStorage.getItem("packetade:project-path");
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
    useAppStore.getState().setInitialized(true);
  }

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
