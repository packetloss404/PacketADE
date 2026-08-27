import { create } from "zustand";
import { loadPersistedState, saveSettingsSlice } from "@/lib/tauri";
import { DEFAULT_AUTONOMY_POLICY, validateAutonomyPolicy } from "@/lib/autonomyPolicy";
import type { AutonomyPolicy } from "@/types/flight";

/**
 * v0.8: must match `core/orchestrator.rs::DEFAULT_AUTO_COMMIT_TRAILER_FORMAT`.
 * The Rust side is the source of truth; this constant lets the UI render
 * the same default in the absence of backend data.
 */
export const DEFAULT_AUTO_COMMIT_TRAILER_FORMAT =
  "Run-By: PacketBench flight F-{flightId} attempt A-{attemptId}";

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
  confirmedAutoCommitTrailerEnabled: boolean;
  confirmedAutoCommitTrailerFormat: string;
  autonomyDefaultMode: "assisted" | "yolo";
  autonomyDefaultPolicy: AutonomyPolicy;
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  lastSaveKind: "trailer" | "autonomy" | null;
  /** Monotonic frontend revision used to keep late save completions from
   * overwriting the status of a newer edit. */
  settingsRevision: number;
  savedRevision: number;

  setAutoCommitTrailerEnabled: (enabled: boolean) => Promise<void>;
  setAutoCommitTrailerFormat: (format: string) => Promise<void>;
  setAutonomyDefault: (mode: "assisted" | "yolo", policy: AutonomyPolicy) => Promise<void>;

  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
}

type SettingsPatch = Partial<Awaited<ReturnType<typeof loadPersistedState>>["settings"]>;

// All Settings-slice writes from this store are serialized. The old
// fire-and-forget read/merge/write sequence allowed two quick edits to finish
// out of order and silently restore stale values.
let settingsWriteQueue: Promise<void> = Promise.resolve();

function queuePersistedSettings(
  patch: SettingsPatch,
  revision: number,
  kind: "trailer" | "autonomy",
  set: (partial: Partial<OrchestrationSettingsState>) => void,
  get: () => OrchestrationSettingsState,
  recordPersisted: () => void,
  applyPersisted: () => void,
  rollback: () => void,
): Promise<void> {
  set({
    saveStatus: "saving",
    saveError: null,
    lastSaveKind: kind,
    settingsRevision: revision,
  });

  const write = settingsWriteQueue.then(async () => {
    const persisted = await loadPersistedState();
    const merged = { ...persisted.settings, ...patch };
    await saveSettingsSlice(merged);
    recordPersisted();
    if (get().settingsRevision === revision) {
      applyPersisted();
      set({ saveStatus: "saved", saveError: null, savedRevision: revision });
    }
  });

  const reported = write.catch((error: unknown) => {
    if (get().settingsRevision === revision) {
      rollback();
      set({
        saveStatus: "error",
        saveError: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  });
  // A failed write must not poison the queue: later user corrections still
  // need a chance to persist.
  settingsWriteQueue = reported.catch(() => undefined);
  return reported;
}

export const useOrchestrationSettingsStore = create<OrchestrationSettingsState>((set, get) => ({
  autoCommitTrailerEnabled: true,
  autoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
  confirmedAutoCommitTrailerEnabled: true,
  confirmedAutoCommitTrailerFormat: DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
  autonomyDefaultMode: "assisted",
  autonomyDefaultPolicy: DEFAULT_AUTONOMY_POLICY,
  saveStatus: "idle",
  saveError: null,
  lastSaveKind: null,
  settingsRevision: 0,
  savedRevision: 0,

  setAutoCommitTrailerEnabled: (enabled) => {
    const revision = get().settingsRevision + 1;
    set({ autoCommitTrailerEnabled: enabled });
    return queuePersistedSettings(
      { autoCommitTrailerEnabled: enabled },
      revision,
      "trailer",
      set,
      get,
      () => set({ confirmedAutoCommitTrailerEnabled: enabled }),
      () => set({ autoCommitTrailerEnabled: enabled }),
      () =>
        set({
          autoCommitTrailerEnabled: get().confirmedAutoCommitTrailerEnabled,
        }),
    );
  },
  setAutoCommitTrailerFormat: (format) => {
    const revision = get().settingsRevision + 1;
    set({ autoCommitTrailerFormat: format });
    return queuePersistedSettings(
      { autoCommitTrailerFormat: format },
      revision,
      "trailer",
      set,
      get,
      () => set({ confirmedAutoCommitTrailerFormat: format }),
      () => set({ autoCommitTrailerFormat: format }),
      () =>
        set({
          autoCommitTrailerFormat: get().confirmedAutoCommitTrailerFormat,
        }),
    );
  },
  setAutonomyDefault: (mode, policy) => {
    if (mode === "yolo") {
      const errors = validateAutonomyPolicy(policy);
      if (errors.length > 0) throw new Error(errors[0]);
    }
    const snapshot = {
      ...policy,
      allowedRoots: [...policy.allowedRoots],
      allowedTargets: [...policy.allowedTargets],
    };
    const revision = get().settingsRevision + 1;
    return queuePersistedSettings(
      {
        autonomyDefaultMode: mode,
        autonomyDefaultPolicy: snapshot,
      },
      revision,
      "autonomy",
      set,
      get,
      () => undefined,
      () => set({ autonomyDefaultMode: mode, autonomyDefaultPolicy: snapshot }),
      () => undefined,
    );
  },

  hydrateFromBackend: async (persisted) => {
    const startingRevision = get().settingsRevision;
    try {
      const state = persisted ?? (await loadPersistedState());
      // Do not let a late bootstrap read replace an edit that started while
      // the backend call was in flight.
      if (get().settingsRevision !== startingRevision) return;
      set({
        autoCommitTrailerEnabled: state.settings.autoCommitTrailerEnabled ?? true,
        confirmedAutoCommitTrailerEnabled: state.settings.autoCommitTrailerEnabled ?? true,
        autoCommitTrailerFormat:
          state.settings.autoCommitTrailerFormat ?? DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
        confirmedAutoCommitTrailerFormat:
          state.settings.autoCommitTrailerFormat ?? DEFAULT_AUTO_COMMIT_TRAILER_FORMAT,
        autonomyDefaultMode: state.settings.autonomyDefaultMode ?? "assisted",
        autonomyDefaultPolicy: state.settings.autonomyDefaultPolicy ?? DEFAULT_AUTONOMY_POLICY,
        saveStatus: "idle",
        saveError: null,
        lastSaveKind: null,
      });
    } catch {
      // Keep defaults when backend is unavailable.
    }
  },
}));
