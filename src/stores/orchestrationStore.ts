import { create } from "zustand";
import {
  cancelFlightInBackend,
  getOrchestrationState,
  killPty,
  launchFlightInBackend,
  loadPersistedState,
  notifyApprovalNeeded,
  notifyApprovalResolved,

  orchestrationTick,
  pauseFlightInBackend,
  recordTaskSpawn,
  resumeFlightInBackend,
  saveSettingsSlice,
} from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import { useLayoutStore } from "@/stores/layoutStore";
import { useTabStore } from "@/stores/tabStore";
import type { Task, Flight } from "@/types/flight";

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
  onTaskApprovalNeeded: (taskId: string) => void;
  onTaskApprovalResolved: (taskId: string) => void;
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

// Topological sort: returns task IDs in dependency order
export function topologicalSort(tasks: Task[]): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task) return;
    for (const depId of task.dependsOn) {
      visit(depId);
    }
    result.push(id);
  }

  for (const task of tasks) {
    visit(task.id);
  }
  return result;
}

// Check if all dependencies of a task are done
function depsResolved(task: Task, allTasks: Task[]): boolean {
  if (task.dependsOn.length === 0) return true;
  return task.dependsOn.every((depId) => {
    const dep = allTasks.find((t) => t.id === depId);
    return dep && dep.status === "done";
  });
}

function clearTaskSessionLink(rt: RunningTask) {
  if (!rt.sessionId) return;

  const flight = useFlightStore.getState().flights.find((entry) => entry.id === rt.flightId);
  const milestone = flight?.milestones.find((entry) => entry.id === rt.milestoneId);

  if (milestone) {
    useFlightStore.getState().updateTask(rt.flightId, milestone.id, rt.taskId, {
      sessionId: null,
    });
  }

  useFlightStore.getState().unlinkSessionFromFlight(rt.flightId, rt.sessionId);
}

// Get all tasks across all milestones for a flight
export function getAllFlightTasks(flight: Flight): Task[] {
  return flight.milestones.flatMap((m) => m.tasks);
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
    const state = get();
    const tasksToStop = Array.from(state.runningTasks.entries()).filter(
      ([, rt]) => rt.flightId === flightId,
    );

    try {
      const persisted = await pauseFlightInBackend(flightId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
      await get().syncFromBackend();
    } catch {
      // Fall back to local shutdown cleanup if backend orchestration is unavailable.
    }

    // Kill PTY sessions
    await Promise.all(
      tasksToStop.map(([, rt]) =>
        rt.sessionId ? killPty(rt.sessionId).catch(() => {}) : undefined,
      ),
    );

    // Remove stopped tasks from local tracking
    set((s) => {
      const runningTasks = new Map(s.runningTasks);
      for (const [taskId] of tasksToStop) {
        runningTasks.delete(taskId);
      }
      return { runningTasks };
    });
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
    const state = get();
    const tasksToStop = Array.from(state.runningTasks.entries()).filter(
      ([, rt]) => rt.flightId === flightId,
    );

    try {
      const persisted = await cancelFlightInBackend(flightId);
      await useFlightStore.getState().hydrateFromBackend(persisted);
      await get().syncFromBackend();
    } catch {
      // Continue cleaning up local PTY state even if backend persistence fails.
    }

    await Promise.all(
      tasksToStop.map(([, rt]) =>
        rt.sessionId ? killPty(rt.sessionId).catch(() => {}) : undefined,
      ),
    );

    set((s) => {
      const runningTasks = new Map(s.runningTasks);
      for (const [taskId] of tasksToStop) {
        runningTasks.delete(taskId);
      }
      return { runningTasks };
    });
  },

  onTaskComplete: (taskId, success) => {
    const state = get();
    const rt = state.runningTasks.get(taskId);
    if (!rt) return;

    const flight = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
    if (!flight) return;

    // Update task status
    for (const ms of flight.milestones) {
      const task = ms.tasks.find((t) => t.id === taskId);
      if (task) {
        useFlightStore.getState().updateTask(rt.flightId, ms.id, taskId, {
          status: success ? "done" : "failed",
          completedAt: Date.now(),
        });

        // Re-resolve dependencies: queue newly eligible tasks in same milestone
        const updatedFlight = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
        const updatedMs = updatedFlight?.milestones.find((m) => m.id === ms.id);
        if (updatedMs) {
          for (const t of updatedMs.tasks) {
            if (t.status === "pending" && depsResolved(t, updatedMs.tasks)) {
              useFlightStore.getState().updateTask(rt.flightId, ms.id, t.id, {
                status: "queued",
              });
            }
          }

          // Check if milestone is complete
          const allDone = updatedMs.tasks.every(
            (t) => t.status === "done" || t.status === "cancelled",
          );
          const anyFailed = updatedMs.tasks.some((t) => t.status === "failed");

          if (allDone || anyFailed) {
            useFlightStore.getState().updateMilestone(rt.flightId, ms.id, {
              status: anyFailed ? "failed" : "done",
            });

            // Advance to next milestone
            const msIdx = flight.milestones.findIndex((m) => m.id === ms.id);
            const nextMs = flight.milestones[msIdx + 1];
            if (nextMs && !anyFailed) {
              if (state.milestoneGating) {
                // Pause at milestone boundary
                set((s) => {
                  const pausedAtMilestone = new Map(s.pausedAtMilestone);
                  pausedAtMilestone.set(rt.flightId, nextMs.id);
                  return { pausedAtMilestone };
                });
                useFlightStore.getState().updateFlight(rt.flightId, { status: "review" });
              } else {
                // Auto-advance: queue tasks in next milestone
                for (const t of nextMs.tasks) {
                  if (t.status === "pending" && depsResolved(t, nextMs.tasks)) {
                    useFlightStore.getState().updateTask(rt.flightId, nextMs.id, t.id, {
                      status: "queued",
                    });
                  }
                }
                useFlightStore.getState().updateMilestone(rt.flightId, nextMs.id, {
                  status: "active",
                });
              }
            } else if (!nextMs) {
              // All milestones done — flight complete
              const finalFlight = useFlightStore
                .getState()
                .flights.find((f) => f.id === rt.flightId);
              const allMsDone = finalFlight?.milestones.every(
                (m) => m.status === "done" || m.status === "failed",
              );
              if (allMsDone) {
                useFlightStore.getState().updateFlight(rt.flightId, {
                  status: anyFailed ? "failed" : "review",
                  completedAt: Date.now(),
                });
                set((s) => {
                  const activeFlightIds = new Set(s.activeFlightIds);
                  activeFlightIds.delete(rt.flightId);
                  return { activeFlightIds };
                });
              }
            }
          }
        }
        break;
      }
    }

    // Remove from running tasks
    set((s) => {
      const runningTasks = new Map(s.runningTasks);
      runningTasks.delete(taskId);
      return { runningTasks };
    });
  },

  onTaskApprovalNeeded: (taskId) => {
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

    // Notify the Rust backend (fire-and-forget)
    notifyApprovalNeeded(taskId).catch(console.error);
  },

  onTaskApprovalResolved: (taskId) => {
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

    // Notify the Rust backend (fire-and-forget)
    notifyApprovalResolved(taskId).catch(console.error);
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
      set({
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
    listen<{ session_id: string; success?: boolean; killed?: boolean }>("pty:exit", (event) => {
      const store = useOrchestrationStore.getState();
      const sessionId = event.payload.session_id;

      // Find the running task for this session
      for (const [taskId, rt] of store.runningTasks) {
        if (rt.sessionId === sessionId) {
          if (event.payload.killed) {
            clearTaskSessionLink(rt);
            useOrchestrationStore.setState((s) => {
              const runningTasks = new Map(s.runningTasks);
              runningTasks.delete(taskId);
              return { runningTasks };
            });
            break;
          }

          // Check tab status to determine success/failure
          const tab = useTabStore.getState().tabs.find((t) => t.ptySessionId === sessionId);
          const success =
            event.payload.success ?? (!event.payload.killed && tab?.status !== "error");
          store.onTaskComplete(taskId, success);

          clearTaskSessionLink(rt);
          break;
        }
      }
    });
  });
}
