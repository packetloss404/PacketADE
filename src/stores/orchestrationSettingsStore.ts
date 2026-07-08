import { create } from "zustand";
import { loadPersistedState, saveSettingsSlice } from "@/lib/tauri";

/**
 * v0.8: must match `core/orchestrator.rs::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT`.
 * The Rust side is the source of truth; this constant lets the UI render
 * the same default in the absence of backend data.
 */
export const DEFAULT_AUTO_COMMIT_TRAILER_FORMAT =
  "Run-By: PacketADE flight F-{flightId} attempt A-{attemptId}";

interface OrchestrationSettingsState {
  /**
   * When true, the Rust worktree provisioner installs a
   * `prepare-commit-msg` hook that appends an auto-trailer to every
   * commit made inside an async flight attempt's worktree. Persisted
   * through `OrchestratorSettings`.
   */
  autoCommitTrailerEnabled: boolean;
  /**
   * Format string for the auto-trailer hook. Recognised placeholders:
   * `{flightId}`, `{attemptId}`, `{flightTitle}`.
   */
  autoCommitTrailerFormat: string;

  setAutoCommitTrailerEnabled: (enabled: boolean) => void;
  setAutoCommitTrailerFormat: (format: string) => void;

  hydrateFromBackend: (
    persisted?: Awaited<ReturnType<typeof loadPersistedState>>,
  ) => Promise<void>;
}

async function patchPersistedSettings(
  patch: Partial<Awaited<ReturnType<typeof loadPersistedState>>["settings"]>,
) {
  try {
    const persisted = await loadPersistedState();
    const merged = { ...persisted.settings, ...patch };
    await saveSettingsSlice(merged);
  } catch {
    // Ignore when backend is unavailable.
  }
}

export const useOrchestrationSettingsStore = create<OrchestrationSettingsState>(
  (set) => ({
    autoCommitTrailerEnabled: true,
    autoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,

    setAutoCommitTrailerEnabled: (enabled) => {
      set({ autoCommitTrailerEnabled: enabled });
      void patchPersistedSettings({ autoCommitTrailerEnabled: enabled });
    },
    setAutoCommitTrailerFormat: (format) => {
      set({ autoCommitTrailerFormat: format });
      void patchPersistedSettings({ autoCommitTrailerFormat: format });
    },

    hydrateFromBackend: async (persisted) => {
      try {
        const state = persisted ?? (await loadPersistedState());
        set({
          autoCommitTrailerEnabled: state.settings.autoCommitTrailerEnabled ?? true,
          autoCommitTrailerFormat:
            state.settings.autoCommitTrailerFormat ?? DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
        });
      } catch {
        // Keep defaults when backend is unavailable.
      }
    },
  }),
);
