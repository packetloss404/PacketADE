import { create } from "zustand";
import type { DeployConfig, DeployRun, DeployStatus, DeployValidation } from "@/types/deploy";
import { readDeployConfig, createDeployConfig, validateDeploy, runDeploy } from "@/lib/tauri";
import { useLayoutStore } from "@/stores/layoutStore";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface DeployStore {
  configs: DeployConfig[];
  configSource: string;
  loading: boolean;
  error: string | null;
  runs: DeployRun[];
  activeRunId: string | null;
  lastValidation: DeployValidation | null;
  validating: boolean;

  fetchConfigs: () => Promise<void>;
  saveConfigs: (configs: DeployConfig[]) => Promise<void>;
  addConfig: (config: DeployConfig) => Promise<void>;
  removeConfig: (name: string) => Promise<void>;
  startRun: (config: DeployConfig) => Promise<void>;
  finishRun: (runId: string, status: DeployStatus) => void;
  setActiveRunId: (id: string | null) => void;
  appendOutput: (runId: string, line: string) => void;
  clearValidation: () => void;
}

let runCounter = 0;

// Track active event listeners for cleanup
const activeListeners: Map<string, UnlistenFn[]> = new Map();

function cleanupListeners(runId: string) {
  const listeners = activeListeners.get(runId);
  if (listeners) {
    listeners.forEach((unlisten) => unlisten());
    activeListeners.delete(runId);
  }
}

export const useDeployStore = create<DeployStore>((set, get) => ({
  configs: [],
  configSource: "none",
  loading: false,
  error: null,
  runs: [],
  activeRunId: null,
  lastValidation: null,
  validating: false,

  fetchConfigs: async () => {
    set({ loading: true, error: null });
    try {
      const projectPath = useLayoutStore.getState().projectPath;
      const result = await readDeployConfig(projectPath);
      set({ configs: result.configs, configSource: result.source, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  saveConfigs: async (configs) => {
    const projectPath = useLayoutStore.getState().projectPath;
    await createDeployConfig(projectPath, configs);
    set({ configs, configSource: "packetade.deploy.json" });
  },

  addConfig: async (config) => {
    const next = [...get().configs, config];
    await get().saveConfigs(next);
  },

  removeConfig: async (name) => {
    const next = get().configs.filter((c) => c.name !== name);
    await get().saveConfigs(next);
  },

  startRun: async (config) => {
    const projectPath = useLayoutStore.getState().projectPath;
    const id = `deploy_${++runCounter}_${Date.now()}`;

    // Validate first
    set({ validating: true, error: null, lastValidation: null });
    try {
      const validationJson = await validateDeploy(projectPath, config.command);
      const validation: DeployValidation = JSON.parse(validationJson);
      set({ lastValidation: validation, validating: false });

      if (!validation.valid) {
        set({ error: `Validation failed: ${validation.errors.join("; ")}` });
        return;
      }
    } catch (e) {
      set({ validating: false, error: `Validation error: ${String(e)}` });
      return;
    }

    // Create the run record
    const run: DeployRun = {
      id,
      configName: config.name,
      command: config.command,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      sessionId: null,
      output: [],
    };
    set((s) => ({
      runs: [run, ...s.runs].slice(0, 20),
      activeRunId: id,
    }));

    // Attach event listeners on the client-minted run id BEFORE invoking the
    // backend. A near-instant deploy could otherwise emit deploy:exit:${id}
    // before the listener exists and be missed, leaving the run stuck
    // 'running'. The id is already minted above, so listeners can bind to it
    // ahead of the invoke.
    const listeners: UnlistenFn[] = [];

    const unlistenOutput = await listen<string>(`deploy:output:${id}`, (event) => {
      get().appendOutput(id, event.payload);
    });
    listeners.push(unlistenOutput);

    // Listen for deploy exit — sole authority for success/failed via the real
    // numeric exit code. finishRun is idempotent, so a late event can never
    // regress an already-finished run.
    const unlistenExit = await listen<number>(`deploy:exit:${id}`, (event) => {
      // Fail-closed: a malformed/non-numeric payload is treated as failure
      // (exit 1) rather than silently passing as success.
      const exitCode = typeof event.payload === "number" ? event.payload : 1;
      get().finishRun(id, exitCode === 0 ? "success" : "failed");
      cleanupListeners(id);
    });
    listeners.push(unlistenExit);

    activeListeners.set(id, listeners);

    // Launch the deploy via backend
    try {
      const sessionId = await runDeploy(projectPath, config.command, id);

      // Update the run with the session ID
      set((s) => ({
        runs: s.runs.map((r) =>
          r.id === id ? { ...r, sessionId } : r
        ),
      }));
    } catch (e) {
      // Backend never launched — tear down the listeners we attached up front
      // so they don't leak, append the error output, then transition the run
      // to failed through finishRun (the single terminal-state writer; its
      // idempotency guard applies here too).
      cleanupListeners(id);
      set((s) => ({
        runs: s.runs.map((r) =>
          r.id === id ? { ...r, output: [...r.output, `Error: ${String(e)}`] } : r
        ),
        error: `Deploy failed to start: ${String(e)}`,
      }));
      get().finishRun(id, "failed");
    }
  },

  finishRun: (runId, status) => {
    set((s) => ({
      runs: s.runs.map((r) => {
        if (r.id !== runId) return r;
        // Idempotent: once a run has reached a terminal state, never regress it.
        // The real numeric exit code from deploy:exit is the sole authority, and
        // late/duplicate events (or a stale fallback) must not overwrite it.
        if (r.status !== "running" || r.finishedAt !== null) return r;
        return { ...r, status, finishedAt: Date.now() };
      }),
    }));
  },

  appendOutput: (runId, line) => {
    set((s) => ({
      runs: s.runs.map((r) =>
        r.id === runId ? { ...r, output: [...r.output, line] } : r
      ),
    }));
  },

  setActiveRunId: (id) => set({ activeRunId: id }),

  clearValidation: () => set({ lastValidation: null }),
}));
