import { loadPersistedState, getCwd, pathIsDir, saveUiSlice, getAppKnownHostsPath } from "@/lib/tauri";
import { logSwallowed } from "@/lib/logSwallowed";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useAppStore } from "@/stores/appStore";
import { useAgentStore } from "@/stores/agentStore";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useOrchestrationSettingsStore } from "@/stores/orchestrationSettingsStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { useServerStore } from "@/stores/serverStore";
import { useIssueStore } from "@/stores/issueStore";
import { migrateSshTargetsToServers } from "@/lib/sshTargetMigration";
import { startBoundedAutonomyRuntime } from "@/stores/boundedAutonomyRuntime";

const PROJECT_PATH_KEY = "packetade:project-path";

/** A path inside the app's own build output is never a real project to launch
 *  CLIs in. Adopting it as a default is what historically poisoned the
 *  persisted project path (see `getCwd()` fallback below), so we reject it. */
function looksLikeBuildDir(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return p.includes("/src-tauri/target/") || p.endsWith("/src-tauri/target");
}

/**
 * Pick the first candidate that actually exists on disk as a directory.
 * Stale entries (e.g. a project path captured before a folder was renamed
 * or deleted) are skipped so they can't break PTY launches. Clears the
 * persisted `project-path` key when the value it held is no longer valid.
 */
async function resolveValidProjectPath(
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  for (const candidate of candidates) {
    const path = candidate?.trim();
    if (!path || looksLikeBuildDir(path)) continue;
    try {
      if (await pathIsDir(path)) return path;
    } catch {
      // Backend probe failed — treat as unverifiable and skip.
    }
  }
  // Nothing valid survived; drop a stale persisted value so it doesn't keep
  // resurfacing and re-poisoning the global project path on every launch.
  try {
    localStorage.removeItem(PROJECT_PATH_KEY);
  } catch {
    // localStorage unavailable — fine.
  }
  return null;
}

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
    useIssueStore.getState().hydrateFromBackend(state.issues);

    // Phase 2: one-time migration of legacy SshTarget records from
    // localStorage into the unified `serverStore`. Runs after hydration so
    // it can merge alongside backend-persisted ServerConfig entries.
    try {
      await migrateSshTargetsToServers();
    } catch (e) {
      console.warn("[bootstrap] SshTarget migration failed:", e);
    }

    // Fetch the app-managed known_hosts path once so buildSshArgs can pin
    // host keys instead of falling back to TOFU. Non-fatal on failure.
    void getAppKnownHostsPath()
      .then((p) => useServerStore.getState().setKnownHostsPath(p))
      .catch((e) => console.warn("[bootstrap] getAppKnownHostsPath failed:", e));

    // Apply theme + force welcome view before doing anything else, so the
    // first paint of the post-bootstrap UI is correctly themed.
    if (state.ui.theme === "dark" || state.ui.theme === "light") {
      useAppStore.getState().setTheme(state.ui.theme);
    }
    useAppStore.getState().setActiveView("welcome");

    // Restore project path: backend settings > localStorage > CWD. Each
    // candidate is validated against the filesystem so a stale path (e.g.
    // captured before a folder was renamed/deleted) can't break PTY launches.
    const backendPath = state.settings.projectPath;
    const localPath = localStorage.getItem(PROJECT_PATH_KEY);
    let cwd: string | null = null;
    try {
      cwd = await getCwd();
    } catch {
      // no CWD available
    }
    const projectPath = await resolveValidProjectPath([backendPath, localPath, cwd]);
    if (projectPath) {
      useLayoutStore.getState().setProjectPath(projectPath);
    }

    // One-time cleanup of the retired agentMosaicStore localStorage key.
    // Safe to keep indefinitely — removeItem is a no-op when the key is absent.
    try {
      localStorage.removeItem("packetade:agent-mosaic-v1");
    } catch {
      // localStorage unavailable — fine.
    }

    // Mark app as initialized so UI persistence can begin.
    useAppStore.getState().setInitialized(true);

    // Heavy stores hydrate in the background — welcome doesn't need them,
    // and they don't make additional backend calls when given pre-loaded
    // state, so this is really just a clarity/intent signal.
    await useFlightStore
      .getState()
      .hydrateFromBackend(state)
      .catch(() => undefined);
    void useAgentStore
      .getState()
      .hydrateFromBackend(state)
      .catch(() => undefined);
    void useOrchestrationSettingsStore
      .getState()
      .hydrateFromBackend(state)
      .catch(() => undefined);
  } catch {
    // Backend unavailable — fall back to localStorage / CWD, validated.
    const localPath = localStorage.getItem(PROJECT_PATH_KEY);
    let cwd: string | null = null;
    try {
      cwd = await getCwd();
    } catch {
      // no CWD available
    }
    const projectPath = await resolveValidProjectPath([localPath, cwd]);
    if (projectPath) {
      useLayoutStore.getState().setProjectPath(projectPath);
    }
    useAppStore.getState().setInitialized(true);
  }

  startBoundedAutonomyRuntime();

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
      theme,
    }).catch(logSwallowed("bootstrap.saveUi"));
  }, 1000);
}
