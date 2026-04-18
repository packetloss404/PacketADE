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

    // Launch the deploy via backend
    try {
      const sessionId = await runDeploy(projectPath, config.command, id);

      // Update the run with the session ID
      set((s) => ({
        runs: s.runs.map((r) =>
          r.id === id ? { ...r, sessionId } : r
        ),
      }));

      // Listen for deploy output events (plain text capture)
      const listeners: UnlistenFn[] = [];

      const unlistenOutput = await listen<string>(`deploy:output:${id}`, (event) => {
        get().appendOutput(id, event.payload);
      });
      listeners.push(unlistenOutput);

      // Listen for deploy exit
      const unlistenExit = await listen<number>(`deploy:exit:${id}`, (event) => {
        const exitCode = typeof event.payload === "number" ? event.payload : 1;
        get().finishRun(id, exitCode === 0 ? "success" : "failed");
        cleanupListeners(id);
      });
      listeners.push(unlistenExit);

      activeListeners.set(id, listeners);
    } catch (e) {
      set((s) => ({
        runs: s.runs.map((r) =>
          r.id === id
            ? { ...r, status: "failed" as DeployStatus, finishedAt: Date.now(), output: [...r.output, `Error: ${String(e)}`] }
            : r
        ),
        error: `Deploy failed to start: ${String(e)}`,
      }));
    }
  },

  finishRun: (runId, status) => {
    set((s) => ({
      runs: s.runs.map((r) =>
        r.id === runId ? { ...r, status, finishedAt: Date.now() } : r
      ),
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
