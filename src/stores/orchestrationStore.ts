import { create } from "zustand";
import {
  cancelFlightInBackend,
  getOrchestrationState,
  launchFlightInBackend,
  loadPersistedState,
  notifyApprovalNeeded,
  notifyApprovalResolved,
  notifyTaskComplete,
  orchestrationTick,
  pauseFlightInBackend,
  recordTaskSpawn,
  resumeFlightInBackend,
  saveSettingsSlice,
} from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import {
  notifyApprovalNeeded as notifyApprovalNeededDesktop,
  notifyFlightFailed as notifyFlightFailedDesktop,
  notifyTaskComplete as notifyTaskCompleteDesktop,
} from "@/lib/notifications";
// Flight types used only for type reference in approval fallback paths

// === Types ===

interface RunningTask {
  taskId: string;
  milestoneId: string;
  flightId: string;
  paneId: string;
  sessionId: string | null;
  agentConfigId: string;
  startedAt: number;
}

interface OrchestrationState {
  /** Currently executing tasks */
  runningTasks: Map<string, RunningTask>;
  /** Max parallel agent sessions */
  maxParallelSessions: number;
  /** Flights currently being orchestrated */
  activeFlightIds: Set<string>;
  /** Whether the scheduling loop is running */
  loopRunning: boolean;
  /** Milestone gating: pause between milestones for review */
  milestoneGating: boolean;
  /** Flights paused at a milestone boundary */
  pausedAtMilestone: Map<string, string>; // flightId -> milestoneId
}

interface OrchestrationStore extends OrchestrationState {
  // Flight lifecycle
  launchFlight: (flightId: string) => Promise<void>;
  pauseFlight: (flightId: string) => Promise<void>;
  resumeFlight: (flightId: string) => Promise<void>;
  cancelFlight: (flightId: string) => Promise<void>;

  // Task lifecycle
  onTaskComplete: (taskId: string, success: boolean) => void;
  onTaskApprovalNeeded: (taskId: string) => Promise<void>;
  onTaskApprovalResolved: (taskId: string) => Promise<void>;
  attachSessionToTask: (taskId: string, sessionId: string) => void;

  // Scheduling
  tick: () => Promise<void>;
  startLoop: () => void;
  stopLoop: () => void;

  // Settings
  setMaxParallelSessions: (max: number) => void;
  setMilestoneGating: (enabled: boolean) => void;

  // Queries
  isFlightActive: (flightId: string) => boolean;
  getRunningTasksForFlight: (flightId: string) => RunningTask[];
  syncFromBackend: () => Promise<void>;
  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
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

let loopInterval: ReturnType<typeof setInterval> | null = null;

export const useOrchestrationStore = create<OrchestrationStore>((set, get) => ({
  runningTasks: new Map(),
  maxParallelSessions: 3,
  activeFlightIds: new Set(),
  loopRunning: false,
  milestoneGating: true,
  pausedAtMilestone: new Map(),

  launchFlight: async (flightId) => {
    try {
      const persisted = await launchFlightInBackend(flightId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
      await get().syncFromBackend();
    } catch {
      return;
    }
    get().startLoop();
  },

  pauseFlight: async (flightId) => {
    try {
      const persisted = await pauseFlightInBackend(flightId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
      await get().syncFromBackend();
    } catch {
      // Keep local state when backend is unavailable.
    }
  },

  resumeFlight: async (flightId) => {
    try {
      const persisted = await resumeFlightInBackend(flightId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
      await get().syncFromBackend();
    } catch {
      return;
    }
    get().startLoop();
  },

  cancelFlight: async (flightId) => {
    try {
      const persisted = await cancelFlightInBackend(flightId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
      await get().syncFromBackend();
    } catch {
      // Keep local state when backend is unavailable.
    }
  },

  onTaskComplete: (_taskId: string, _success: boolean) => {
    // DEPRECATED: Task completion is now handled by the Rust backend
    // via notify_task_complete. See setupExitListener.
  },

  onTaskApprovalNeeded: async (taskId) => {
    // Fire desktop notification using current task/session info before hydration
    {
      const rt = get().runningTasks.get(taskId);
      if (rt) {
        const flight = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
        const task = flight?.milestones
          .flatMap((m) => m.tasks)
          .find((t) => t.id === taskId);
        const name = task?.title ?? flight?.title ?? "Task";
        void notifyApprovalNeededDesktop(rt.sessionId ?? taskId, name);
      }
    }
    try {
      const persisted = await notifyApprovalNeeded(taskId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
    } catch {
      // Fallback: update locally if backend unavailable
      const state = get();
      const rt = state.runningTasks.get(taskId);
      if (!rt) return;
      const flight = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
      if (!flight) return;
      for (const ms of flight.milestones) {
        const task = ms.tasks.find((t) => t.id === taskId);
        if (task) {
          useFlightStore.getState().updateTask(rt.flightId, ms.id, taskId, {
            status: "approval_needed",
          });
          break;
        }
      }
    }
  },

  onTaskApprovalResolved: async (taskId) => {
    try {
      const persisted = await notifyApprovalResolved(taskId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
    } catch {
      // Fallback: update locally if backend unavailable
      const state = get();
      const rt = state.runningTasks.get(taskId);
      if (!rt) return;
      const flight = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
      if (!flight) return;
      for (const ms of flight.milestones) {
        const task = ms.tasks.find((t) => t.id === taskId);
        if (!task) continue;
        if (task.status === "approval_needed") {
          useFlightStore.getState().updateTask(rt.flightId, ms.id, taskId, {
            status: "running",
          });
        }
        break;
      }
    }
  },

  attachSessionToTask: (taskId, sessionId) => {
    const state = get();
    const rt = state.runningTasks.get(taskId);
    if (!rt || rt.sessionId === sessionId) return;

    set((s) => {
      const runningTasks = new Map(s.runningTasks);
      const current = runningTasks.get(taskId);
      if (current) {
        runningTasks.set(taskId, { ...current, sessionId });
      }
      return { runningTasks };
    });

    useFlightStore.getState().linkSessionToFlight(rt.flightId, sessionId);
    useFlightStore.getState().updateTask(rt.flightId, rt.milestoneId, taskId, {
      sessionId,
    });
  },

  tick: async () => {
    const state = get();
    const currentRunning = state.runningTasks.size;
    const available = state.maxParallelSessions - currentRunning;
    if (available <= 0) return;

    const flightStore = useFlightStore.getState();
    const requests = await orchestrationTick().catch(() => []);

    for (const request of requests.slice(0, available)) {
      const flight = flightStore.flights.find((entry) => entry.id === request.flightId);
      const milestone = flight?.milestones.find((entry) => entry.id === request.milestoneId);
      const task = milestone?.tasks.find((entry) => entry.id === request.taskId);
      if (!flight || !milestone || !task || state.runningTasks.has(task.id)) continue;

      const paneId = useLayoutStore.getState().addPane({
        cliCommand: request.command,
        cliArgs: request.args,
        initialPrompt: request.prompt,
        projectPath: request.projectPath,
        agentConfigId: request.agentConfigId,
        taskId: request.taskId,
        flightId: request.flightId,
      });

      // Notify Rust orchestrator about the spawn (it updates flight/task state)
      void recordTaskSpawn({
        sessionId: "", // Will be attached later via attachSessionToTask
        flightId: request.flightId,
        milestoneId: request.milestoneId,
        taskId: request.taskId,
        agentConfigId: request.agentConfigId,
        command: request.command,
        args: request.args,
        prompt: request.prompt,
        projectPath: request.projectPath,
      });

      set((s) => {
        const runningTasks = new Map(s.runningTasks);
        runningTasks.set(request.taskId, {
          taskId: request.taskId,
          milestoneId: request.milestoneId,
          flightId: request.flightId,
          paneId,
          sessionId: null,
          agentConfigId: request.agentConfigId,
          startedAt: Date.now(),
        });
        return { runningTasks };
      });
    }
  },

  startLoop: () => {
    if (loopInterval) return;
    set({ loopRunning: true });
    loopInterval = setInterval(() => {
      void get().tick();

      // Stop loop if no active flights
      const state = get();
      if (state.activeFlightIds.size === 0 && state.runningTasks.size === 0) {
        get().stopLoop();
      }
    }, 1000);
    // Run immediately
    void get().tick();
  },

  stopLoop: () => {
    if (loopInterval) {
      clearInterval(loopInterval);
      loopInterval = null;
    }
    set({ loopRunning: false });
  },

  setMaxParallelSessions: (max) => {
    set({ maxParallelSessions: max });
    void patchPersistedSettings({ maxParallelSessions: max });
  },
  setMilestoneGating: (enabled) => {
    set({ milestoneGating: enabled });
    void patchPersistedSettings({ milestoneGating: enabled });
  },

  isFlightActive: (flightId) => get().activeFlightIds.has(flightId),

  getRunningTasksForFlight: (flightId) => {
    const tasks: RunningTask[] = [];
    for (const rt of get().runningTasks.values()) {
      if (rt.flightId === flightId) tasks.push(rt);
    }
    return tasks;
  },

  syncFromBackend: async () => {
    try {
      const snapshot = await getOrchestrationState();
      const runningTasks = new Map<string, RunningTask>();
      for (const rt of snapshot.runningTasks) {
        const existing = get().runningTasks.get(rt.taskId);
        runningTasks.set(rt.taskId, {
          taskId: rt.taskId,
          milestoneId: rt.milestoneId,
          flightId: rt.flightId,
          paneId: existing?.paneId ?? "",
          sessionId: rt.sessionId || null,
          agentConfigId: rt.agentConfigId,
          startedAt: rt.startedAt,
        });
      }
      set({
        runningTasks,
        activeFlightIds: new Set(snapshot.activeFlightIds),
        pausedAtMilestone: new Map(snapshot.pausedAtMilestone),
      });
    } catch {
      // Keep local state when backend is unavailable.
    }
  },

  hydrateFromBackend: async (persisted) => {
    try {
      const state = persisted ?? (await loadPersistedState());
      set({
        maxParallelSessions: state.settings.maxParallelSessions,
        milestoneGating: state.settings.milestoneGating,
      });
    } catch {
      // Keep defaults when backend is unavailable.
    }
  },
}));

// === Session Exit Listener ===
// Listen for PTY exit events and mark tasks as complete

let exitListenerSetup = false;

export function setupExitListener() {
  if (exitListenerSetup) return;
  exitListenerSetup = true;

  // Import dynamically to avoid circular deps
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen<{ session_id: string; success?: boolean; killed?: boolean }>("pty:exit", async (event) => {
      const store = useOrchestrationStore.getState();
      const sessionId = event.payload.session_id;

      // Find the running task for this session
      for (const [taskId, rt] of store.runningTasks) {
        if (rt.sessionId === sessionId) {
          if (event.payload.killed) {
            // Killed manually — just remove from local tracking, backend already handled
            useOrchestrationStore.setState((s) => {
              const runningTasks = new Map(s.runningTasks);
              runningTasks.delete(taskId);
              return { runningTasks };
            });
            break;
          }

          // Determine success/failure
          const tab = useTabStore.getState().tabs.find((t) => t.ptySessionId === sessionId);
          const success =
            event.payload.success ?? (!event.payload.killed && tab?.status !== "error");

          // Capture task + flight info for notifications before hydration
          const flightStoreBefore = useFlightStore.getState();
          const flightBefore = flightStoreBefore.flights.find((f) => f.id === rt.flightId);
          const taskBefore = flightBefore?.milestones
            .flatMap((m) => m.tasks)
            .find((t) => t.id === taskId);
          const taskName = taskBefore?.title ?? "Task";
          const flightName = flightBefore?.title ?? "Flight";
          const flightStatusBefore = flightBefore?.status;

          // Fire task-complete notification on success
          if (success) {
            void notifyTaskCompleteDesktop(taskId, taskName);
          }

          // Notify the Rust backend — this is the single source of truth
          try {
            const persisted = await notifyTaskComplete(taskId, success);
            await useFlightStore.getState().hydrateFromBackend(persisted);
            await store.syncFromBackend();

            // Detect flight failure transition post-hydration
            const flightAfter = useFlightStore
              .getState()
              .flights.find((f) => f.id === rt.flightId);
            if (
              flightAfter &&
              flightAfter.status === "failed" &&
              flightStatusBefore !== "failed"
            ) {
              void notifyFlightFailedDesktop(flightName);
            }
          } catch {
            // If backend is unavailable, fall back to local cleanup only
            useOrchestrationStore.setState((s) => {
              const runningTasks = new Map(s.runningTasks);
              runningTasks.delete(taskId);
              return { runningTasks };
            });
          }
          break;
        }
      }
    });
  });
}
