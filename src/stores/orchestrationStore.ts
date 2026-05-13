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
import { useAgentStore } from "@/stores/agentStore";
import { useMemoryStore } from "@/stores/memoryStore";
import {
  notifyApprovalNeeded as notifyApprovalNeededDesktop,
  notifyFlightFailed as notifyFlightFailedDesktop,
  notifyTaskComplete as notifyTaskCompleteDesktop,
} from "@/lib/notifications";

// === Types ===

interface RunningTask {
  taskId: string;
  milestoneId: string;
  flightId: string;
  paneId: string;
  sessionId: string | null;
  agentConfigId: string;
  startedAt: number;
  command: string;
  args: string[];
  prompt: string;
  projectPath: string;
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
  onTaskComplete: (taskId: string, success: boolean) => Promise<void>;
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

const MIN_PARALLEL_SESSIONS = 1;
const MAX_PARALLEL_SESSIONS = 12;

function clampParallelSessions(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.min(MAX_PARALLEL_SESSIONS, Math.max(MIN_PARALLEL_SESSIONS, Math.round(value)));
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

async function hydrateFlightsAndRuntime(
  persisted: Awaited<ReturnType<typeof loadPersistedState>>,
  syncRuntime: () => Promise<void>,
) {
  await useFlightStore.getState().hydrateFromBackend(persisted);
  await syncRuntime();
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
    // Validate agent availability before launching
    try {
      const agents = useAgentStore.getState().agents;
      const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
      if (flight) {
        const installedIds = new Set(agents.filter((a) => a.installed).map((a) => a.id));
        const fallbackAgent = agents.find((a) => a.installed)?.id ?? "claude-code";
        for (const ms of flight.milestones) {
          for (const task of ms.tasks) {
            if (task.agentConfigId && !installedIds.has(task.agentConfigId)) {
              useFlightStore.getState().updateTask(flight.id, ms.id, task.id, {
                agentConfigId: fallbackAgent,
              });
            }
          }
        }
      }
    } catch {
      // Non-fatal: proceed with existing assignments
    }

    try {
      const persisted = await launchFlightInBackend(flightId);
      await hydrateFlightsAndRuntime(persisted, get().syncFromBackend);
    } catch {
      return;
    }
    get().startLoop();
  },

  pauseFlight: async (flightId) => {
    try {
      const persisted = await pauseFlightInBackend(flightId);
      await hydrateFlightsAndRuntime(persisted, get().syncFromBackend);
    } catch {
      // Keep local state when backend is unavailable.
    }
  },

  resumeFlight: async (flightId) => {
    try {
      const persisted = await resumeFlightInBackend(flightId);
      await hydrateFlightsAndRuntime(persisted, get().syncFromBackend);
    } catch {
      return;
    }
    get().startLoop();
  },

  cancelFlight: async (flightId) => {
    try {
      const persisted = await cancelFlightInBackend(flightId);
      await hydrateFlightsAndRuntime(persisted, get().syncFromBackend);
    } catch {
      // Keep local state when backend is unavailable.
    }
  },

  onTaskComplete: async (taskId, success) => {
    const state = get();
    const rt = state.runningTasks.get(taskId);
    if (!rt) return;

    const flightStoreBefore = useFlightStore.getState();
    const flightBefore = flightStoreBefore.flights.find((f) => f.id === rt.flightId);
    const taskBefore = flightBefore?.milestones
      .flatMap((m) => m.tasks)
      .find((t) => t.id === taskId);
    const taskName = taskBefore?.title ?? "Task";
    const flightName = flightBefore?.title ?? "Flight";
    const flightStatusBefore = flightBefore?.status;

    if (success) {
      void notifyTaskCompleteDesktop(taskId, taskName);
    }

    try {
      const persisted = await notifyTaskComplete(taskId, success);
      await hydrateFlightsAndRuntime(persisted, get().syncFromBackend);

      const flightAfter = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
      if (flightAfter && flightAfter.status === "failed" && flightStatusBefore !== "failed") {
        void notifyFlightFailedDesktop(flightName);
      }

      // Auto-capture task completion to Memory
      const taskAfter = flightAfter?.milestones
        .flatMap((m) => m.tasks)
        .find((t) => t.id === taskId);
      if (taskAfter && flightAfter) {
        useMemoryStore.getState().captureTaskCompleted(
          {
            taskId,
            taskTitle: taskAfter.title,
            flightId: rt.flightId,
            flightTitle: flightAfter.title,
            milestoneId: rt.milestoneId,
            success,
            exitCode: taskAfter.result?.exitCode ?? null,
            summary: taskAfter.result?.summary ?? "",
            filesChanged: taskAfter.result?.filesChanged ?? [],
            errors: taskAfter.result?.errors ?? [],
            durationMs: taskAfter.result?.duration ?? 0,
          },
          rt.projectPath,
        );
      }

      // Auto-capture flight completion to Memory (retrospective)
      if (
        flightAfter &&
        (flightAfter.status === "done" || flightAfter.status === "failed") &&
        flightStatusBefore !== "done" &&
        flightStatusBefore !== "failed"
      ) {
        const allTasks = flightAfter.milestones.flatMap((m) => m.tasks);
        useMemoryStore.getState().captureFlightCompleted(
          {
            flightId: flightAfter.id,
            flightTitle: flightAfter.title,
            summary: `Flight "${flightAfter.title}" ${flightAfter.status}. ${allTasks.filter((t) => t.status === "done").length}/${allTasks.length} tasks completed.`,
            whatWorked: allTasks
              .filter((t) => t.status === "done" && t.result?.summary)
              .map((t) => t.result!.summary),
            whatFailed: allTasks
              .filter((t) => t.status === "failed" && t.result?.errors.length)
              .map((t) => `${t.title}: ${t.result!.errors[0]}`),
            lessonsLearned: [],
            suggestedImprovements: [],
            tags: [flightAfter.priority, flightAfter.status],
          },
          rt.projectPath,
        );
      }
    } catch {
      useOrchestrationStore.setState((s) => {
        const runningTasks = new Map(s.runningTasks);
        runningTasks.delete(taskId);
        return { runningTasks };
      });
    }
  },

  onTaskApprovalNeeded: async (taskId) => {
    // Fire desktop notification using current task/session info before hydration
    {
      const rt = get().runningTasks.get(taskId);
      if (rt) {
        const flight = useFlightStore.getState().flights.find((f) => f.id === rt.flightId);
        const task = flight?.milestones.flatMap((m) => m.tasks).find((t) => t.id === taskId);
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

    void recordTaskSpawn({
      sessionId,
      flightId: rt.flightId,
      milestoneId: rt.milestoneId,
      taskId,
      agentConfigId: rt.agentConfigId,
      command: rt.command,
      args: rt.args,
      prompt: rt.prompt,
      projectPath: rt.projectPath,
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

      // Check for file ownership collisions before launching
      const collisions = flightStore.checkFileCollisions(
        request.flightId,
        request.milestoneId,
        request.taskId,
      );
      if (collisions.length > 0) {
        console.warn(
          `[orchestration] File collision detected for task "${task.title}": ${collisions.join(", ")}. Blocking task.`,
        );
        flightStore.setTaskBlocked(
          request.flightId,
          request.milestoneId,
          request.taskId,
          `File ownership collision: ${collisions.join("; ")}`,
        );
        flightStore.addCoordinationEvent(request.flightId, {
          flightId: request.flightId,
          type: "collision_warning",
          taskId: request.taskId,
          taskTitle: task.title,
          agentId: task.agentConfigId,
          summary: `Task "${task.title}" blocked due to file collisions: ${collisions.join(", ")}`,
        });
        continue;
      }

      const paneId = useLayoutStore.getState().addPane({
        cliCommand: request.command,
        cliArgs: request.args,
        initialPrompt: request.prompt,
        projectPath: request.projectPath,
        agentConfigId: request.agentConfigId,
        taskId: request.taskId,
        flightId: request.flightId,
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
          command: request.command,
          args: request.args,
          prompt: request.prompt,
          projectPath: request.projectPath,
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
    const clamped = clampParallelSessions(max);
    set({ maxParallelSessions: clamped });
    void patchPersistedSettings({ maxParallelSessions: clamped });
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
          command: existing?.command ?? "",
          args: existing?.args ?? [],
          prompt: existing?.prompt ?? "",
          projectPath: existing?.projectPath ?? "",
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
        maxParallelSessions: clampParallelSessions(state.settings.maxParallelSessions),
        milestoneGating: state.settings.milestoneGating,
      });
    } catch {
      // Keep defaults when backend is unavailable.
    }
  },
}));
