import { create } from "zustand";
import { generateId as genId } from "@/lib/storage";
import { loadPersistedState, saveFlightsSlice, saveUiSlice } from "@/lib/tauri";
import type {
  Flight,
  FlightStatus,
  Milestone,
  Task,
  TaskHandoff,
  CoordinationEvent,
} from "@/types/flight";
import { useIssueStore } from "@/stores/issueStore";
import { useRoutingStore } from "@/stores/routingStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { claimedPathsOverlap } from "@/lib/pathCollisions";

type FlightState = {
  flights: Flight[];
  activeFlightId: string | null;
};

const generateId = (prefix: string) => genId(prefix);

function loadState(): FlightState {
  // Backend is the sole source of truth; real data arrives via hydrateFromBackend.
  return { flights: [], activeFlightId: null };
}

function saveState(state: FlightState) {
  void syncFlightsToBackend(state);
}

async function syncFlightsToBackend(state: FlightState) {
  try {
    await saveFlightsSlice(state.flights);
    await saveUiSlice({ selectedFlightId: state.activeFlightId });
  } catch (err) {
    console.warn("[flightStore.persist] swallowed error:", err);
  }
}

// === Helpers ===

function getAllTasks(flight: Flight): Task[] {
  return flight.milestones.flatMap((m) => m.tasks);
}

function computeMilestoneStatus(milestone: Milestone): Milestone["status"] {
  if (milestone.tasks.length === 0) return "pending";
  if (milestone.tasks.every((t) => t.status === "done")) return "done";
  if (milestone.tasks.some((t) => t.status === "failed")) return "failed";
  if (
    milestone.tasks.some(
      (t) => t.status === "running" || t.status === "queued" || t.status === "approval_needed",
    )
  )
    return "active";
  return "pending";
}

function computeStatusFromTasks(flight: Flight): FlightStatus | null {
  if (flight.milestones.length === 0) return null;
  const tasks = getAllTasks(flight);
  if (tasks.length === 0) return null;
  if (tasks.some((t) => t.status === "approval_needed")) return "active";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  if (tasks.every((t) => t.status === "done")) return "review";
  if (tasks.some((t) => t.status === "running" || t.status === "queued")) return "active";
  if (tasks.some((t) => t.status === "blocked")) return "active";
  return null;
}

function computeStatusFromIssues(flight: Flight): FlightStatus | null {
  if (!flight.issueIds || flight.issueIds.length === 0) return null;
  const { issues } = useIssueStore.getState();
  const linked = issues.filter((i) => flight.issueIds.includes(i.id));
  if (linked.length === 0) return null;
  if (linked.some((i) => i.status === "needs_human")) return "paused";
  if (linked.some((i) => i.status === "blocked")) return "paused";
  if (linked.every((i) => i.status === "done")) return "done";
  if (linked.some((i) => i.status === "in_progress" || i.status === "qa")) return "active";
  return null;
}

function computeStatusFromAttempts(flight: Flight): FlightStatus | null {
  const attempts = flight.attempts;
  if (!attempts || attempts.length === 0) return null;
  const all = (s: string) => attempts.every((a) => a.status === s);
  const some = (s: string) => attempts.some((a) => a.status === s);
  if (all("cancelled")) return "paused";
  if (all("failed")) return "failed";
  if (all("completed")) return "done";
  if (some("running") || some("provisioning") || some("queued")) return "active";
  if (some("reviewing")) return "review";
  // Mixed terminal states (e.g. some completed, some failed, some cancelled).
  if (some("failed")) return "failed";
  if (some("completed")) return "done";
  return null;
}

function computeStatus(flight: Flight): FlightStatus {
  return (
    computeStatusFromAttempts(flight) ??
    computeStatusFromTasks(flight) ??
    computeStatusFromIssues(flight) ??
    flight.status
  );
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function reconcileIssueIdsFromIssues(
  flights: Flight[],
  touchUpdatedAt: boolean,
): { flights: Flight[]; changed: boolean } {
  if (flights.length === 0) return { flights, changed: false };

  const flightIds = new Set(flights.map((flight) => flight.id));
  const issueIdsByFlight = new Map<string, string[]>();

  for (const issue of useIssueStore.getState().issues) {
    if (!issue.flightId || !flightIds.has(issue.flightId)) continue;
    const issueIds = issueIdsByFlight.get(issue.flightId) ?? [];
    if (!issueIds.includes(issue.id)) {
      issueIds.push(issue.id);
    }
    issueIdsByFlight.set(issue.flightId, issueIds);
  }

  let changed = false;
  const now = touchUpdatedAt ? Date.now() : null;
  const reconciled = flights.map((flight) => {
    const issueIds = issueIdsByFlight.get(flight.id) ?? [];
    if (sameIds(flight.issueIds, issueIds)) return flight;
    changed = true;
    return {
      ...flight,
      issueIds,
      updatedAt: now ?? flight.updatedAt,
    };
  });

  return { flights: reconciled, changed };
}

// === Store ===

interface FlightStore {
  flights: Flight[];
  activeFlightId: string | null;

  // Flight CRUD
  addFlight: (
    flight: Pick<Flight, "title" | "objective" | "priority" | "projectPath"> &
      Partial<Pick<Flight, "gitBranch" | "issueIds" | "workspaceId" | "publishAttemptsAsPrs">>,
  ) => Flight;
  updateFlight: (id: string, updates: Partial<Flight>) => void;
  deleteFlight: (id: string) => void;
  setActiveFlight: (id: string | null) => void;
  getActiveFlight: () => Flight | null;

  // Milestone management
  addMilestone: (
    flightId: string,
    milestone: Pick<Milestone, "title" | "description" | "validationCriteria">,
  ) => string;
  updateMilestone: (flightId: string, milestoneId: string, updates: Partial<Milestone>) => void;
  deleteMilestone: (flightId: string, milestoneId: string) => void;

  // Task management
  addTask: (
    flightId: string,
    milestoneId: string,
    task: Pick<Task, "title" | "description" | "type" | "dependsOn"> & {
      agentConfigId?: string;
      model?: string;
      role?: Task["role"];
      ownedPaths?: string[];
    },
  ) => string;
  updateTask: (
    flightId: string,
    milestoneId: string,
    taskId: string,
    updates: Partial<Task>,
  ) => void;
  deleteTask: (flightId: string, milestoneId: string, taskId: string) => void;

  // Handoff & blocked
  appendHandoff: (
    flightId: string,
    milestoneId: string,
    taskId: string,
    handoff: TaskHandoff,
  ) => void;
  setTaskBlocked: (flightId: string, milestoneId: string, taskId: string, reason: string) => void;

  // Session linking
  linkSessionToFlight: (flightId: string, sessionId: string) => void;
  unlinkSessionFromFlight: (flightId: string, sessionId: string) => void;

  /**
   * Track B: return the workspace id bound to this flight, creating one
   * lazily if absent. Each flight gets one workspace named
   * `"Flight: {flight.title}"` whose `projectPath` mirrors the flight's,
   * and whose agent slots are derived from the flight's task agent
   * configs. Idempotent — repeated calls for the same flight return the
   * same id and never recreate the workspace. Returns `null` if the
   * flight doesn't exist.
   */
  ensureFlightWorkspace: (flightId: string) => string | null;

  // Issue linking
  addIssueToFlight: (flightId: string, issueId: string) => void;
  removeIssueFromFlight: (flightId: string, issueId: string) => void;
  getFlightForIssue: (issueId: string) => Flight | null;

  // File ownership collision detection
  checkFileCollisions: (flightId: string, milestoneId: string, taskId: string) => string[];

  // Coordination log
  addCoordinationEvent: (
    flightId: string,
    event: Omit<CoordinationEvent, "id" | "timestamp">,
  ) => void;
  getCoordinationLog: (flightId: string) => CoordinationEvent[];

  // Computed status
  computeFlightStatus: (flightId: string) => FlightStatus;
  getFlightProgress: (flightId: string) => { done: number; total: number };
  getAttentionFlights: () => Flight[];
  /**
   * Reverse-lookup a Task by its bound session id. Used by the Review-queue
   * wiring to map api-agent permission-request events (keyed by sessionId,
   * which for API conversations equals the AgentConversation id) back to the
   * orchestrator Task they belong to — so the Toolbar Bell / ReviewQueueView
   * pick up approval prompts from API agents, not just PTY-orchestrated ones.
   * Returns null for free-standing chats (no bound task).
   */
  findTaskBySessionId: (
    sessionId: string,
  ) => { flight: Flight; milestone: Milestone; task: Task } | null;
  // `issueIds` is a legacy frontend cache; Rust flights do not round-trip it.
  reconcileIssueLinks: (options?: { persist?: boolean; touchUpdatedAt?: boolean }) => void;
  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
  reconcileLiveSessions: (liveSessionIds: string[]) => void;
}

const initial = loadState();

export const useFlightStore = create<FlightStore>((set, get) => ({
  ...initial,

  addFlight: (input) => {
    const state = get();
    const newFlight: Flight = {
      id: generateId("flight"),
      title: input.title,
      objective: input.objective,
      status: "draft",
      priority: input.priority,
      projectPath: input.projectPath,
      workspaceId: input.workspaceId ?? null,
      gitBranch: input.gitBranch,
      milestones: [],
      linkedSessionIds: [],
      issueIds: input.issueIds ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
      publishAttemptsAsPrs: input.publishAttemptsAsPrs ?? false,
    };
    const newState: FlightState = {
      flights: [...state.flights, newFlight],
      activeFlightId: state.activeFlightId,
    };
    set({ flights: newState.flights });
    saveState(newState);
    return newFlight;
  },

  updateFlight: (id, updates) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === id ? { ...f, ...updates, updatedAt: Date.now() } : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  deleteFlight: (id) => {
    // Clear flightId from any linked issues before removing the flight
    const flight = get().flights.find((f) => f.id === id);
    if (flight && flight.issueIds) {
      const { assignToFlight } = useIssueStore.getState();
      for (const issueId of flight.issueIds) {
        assignToFlight(issueId, null);
      }
    }

    set((s) => {
      const flights = s.flights.filter((f) => f.id !== id);
      const activeFlightId = s.activeFlightId === id ? null : s.activeFlightId;
      saveState({ flights, activeFlightId });
      return { flights, activeFlightId };
    });
  },

  setActiveFlight: (id) => {
    set((s) => {
      saveState({ flights: s.flights, activeFlightId: id });
      return { activeFlightId: id };
    });
  },

  getActiveFlight: () => {
    const { flights, activeFlightId } = get();
    if (!activeFlightId) return null;
    return flights.find((f) => f.id === activeFlightId) ?? null;
  },

  // === Milestone management ===

  addMilestone: (flightId, input) => {
    const msId = generateId("ms");
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestone: Milestone = {
          id: msId,
          flightId,
          title: input.title,
          description: input.description,
          order: f.milestones.length,
          status: "pending",
          tasks: [],
          validationCriteria: input.validationCriteria,
        };
        return { ...f, milestones: [...f.milestones, milestone], updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
    return msId;
  },

  updateMilestone: (flightId, milestoneId, updates) => {
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestones = f.milestones.map((m) =>
          m.id === milestoneId ? { ...m, ...updates } : m,
        );
        return { ...f, milestones, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  deleteMilestone: (flightId, milestoneId) => {
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        return {
          ...f,
          milestones: f.milestones.filter((m) => m.id !== milestoneId),
          updatedAt: Date.now(),
        };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  // === Task management ===

  addTask: (flightId, milestoneId, input) => {
    // Resolve agent + model from routing table when not explicitly provided
    const routing = useRoutingStore.getState().resolveForTask(input.type);
    const agentConfigId = input.agentConfigId ?? routing.agentConfigId;
    const model = input.model ?? routing.model;
    const taskId = generateId("task");

    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestones = f.milestones.map((m) => {
          if (m.id !== milestoneId) return m;
          const task: Task = {
            id: taskId,
            milestoneId,
            flightId,
            title: input.title,
            description: input.description,
            order: m.tasks.length,
            status: "pending",
            type: input.type,
            role: input.role ?? "builder",
            ownedPaths: input.ownedPaths ?? [],
            agentConfigId,
            dependsOn: input.dependsOn,
            sessionId: null,
            createdAt: Date.now(),
            cost: 0,
            tokens: 0,
            ...(model ? { model } : {}),
          };
          return { ...m, tasks: [...m.tasks, task] };
        });
        return { ...f, milestones, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
    return taskId;
  },

  updateTask: (flightId, milestoneId, taskId, updates) => {
    // Capture old task for coordination event detection
    const prevFlight = get().flights.find((f) => f.id === flightId);
    const prevTask = prevFlight?.milestones
      .find((m) => m.id === milestoneId)
      ?.tasks.find((t) => t.id === taskId);

    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestones = f.milestones.map((m) => {
          if (m.id !== milestoneId) return m;
          const tasks = m.tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t));
          const updatedMilestone = { ...m, tasks, status: computeMilestoneStatus({ ...m, tasks }) };
          return updatedMilestone;
        });
        return { ...f, milestones, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });

    // Auto-create coordination events on task status transitions
    if (prevTask && updates.status && updates.status !== prevTask.status) {
      const statusEventMap: Record<
        string,
        { type: CoordinationEvent["type"]; verb: string } | undefined
      > = {
        running: { type: "task_started", verb: "started" },
        done: { type: "task_completed", verb: "completed" },
        failed: { type: "task_failed", verb: "failed" },
        approval_needed: { type: "review_requested", verb: "requested review" },
      };
      const mapping = statusEventMap[updates.status];
      if (mapping) {
        get().addCoordinationEvent(flightId, {
          flightId,
          type: mapping.type,
          taskId,
          taskTitle: prevTask.title,
          agentId: prevTask.agentConfigId,
          summary: `Task "${prevTask.title}" ${mapping.verb}`,
        });
      }
    }
  },

  deleteTask: (flightId, milestoneId, taskId) => {
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestones = f.milestones.map((m) => {
          if (m.id !== milestoneId) return m;
          return { ...m, tasks: m.tasks.filter((t) => t.id !== taskId) };
        });
        return { ...f, milestones, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  // === Handoff & blocked ===

  appendHandoff: (flightId, milestoneId, taskId, handoff) => {
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestones = f.milestones.map((m) => {
          if (m.id !== milestoneId) return m;
          const tasks = m.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const handoffLog = [...(t.handoffLog ?? []), handoff];
            return {
              ...t,
              handoffLog,
              result: {
                ...(t.result ?? {
                  exitCode: null,
                  summary: "",
                  filesChanged: [],
                  errors: [],
                  duration: 0,
                }),
                handoff,
              },
            };
          });
          return { ...m, tasks };
        });
        return { ...f, milestones, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  setTaskBlocked: (flightId, milestoneId, taskId, reason) => {
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const milestones = f.milestones.map((m) => {
          if (m.id !== milestoneId) return m;
          const tasks = m.tasks.map((t) =>
            t.id === taskId ? { ...t, status: "blocked" as const, blockedReason: reason } : t,
          );
          const updatedMilestone = { ...m, tasks, status: computeMilestoneStatus({ ...m, tasks }) };
          return updatedMilestone;
        });
        return { ...f, milestones, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  // === Workspace binding (Track B) ===

  ensureFlightWorkspace: (flightId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    if (!flight) return null;

    // Already bound — verify the workspace still exists. If the user
    // manually deleted the workspace, fall through to recreate one.
    if (flight.workspaceId) {
      const existing = useWorkspaceStore
        .getState()
        .workspaces.find((w) => w.id === flight.workspaceId);
      if (existing) return existing.id;
    }

    // The orchestrator owns pane lifecycle for this workspace — each
    // running task spawns one pane via `workspaceStore.addPane`. We start
    // with an empty `agents` list and let the agentConfigId on each spawn
    // determine its slot (see `orchestrationStore.tick`). This mirrors
    // the legacy `layoutStore.addPane` behavior, which spawned mosaic
    // panes on demand with no preconfigured slots.
    const workspaceId = useWorkspaceStore
      .getState()
      .createWorkspace(`Flight: ${flight.title}`, [], flight.projectPath);

    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId ? { ...f, workspaceId, updatedAt: Date.now() } : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });

    return workspaceId;
  },

  // === Session linking ===

  linkSessionToFlight: (flightId, sessionId) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId && !f.linkedSessionIds.includes(sessionId)
          ? { ...f, linkedSessionIds: [...f.linkedSessionIds, sessionId], updatedAt: Date.now() }
          : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  unlinkSessionFromFlight: (flightId, sessionId) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId
          ? {
              ...f,
              linkedSessionIds: f.linkedSessionIds.filter((id) => id !== sessionId),
              updatedAt: Date.now(),
            }
          : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  // === Issue linking (PacketADE-specific legacy) ===

  addIssueToFlight: (flightId, issueId) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId && !f.issueIds.includes(issueId)
          ? { ...f, issueIds: [...f.issueIds, issueId], updatedAt: Date.now() }
          : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  removeIssueFromFlight: (flightId, issueId) => {
    set((s) => {
      const flights = s.flights.map((f) =>
        f.id === flightId
          ? { ...f, issueIds: f.issueIds.filter((id) => id !== issueId), updatedAt: Date.now() }
          : f,
      );
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  getFlightForIssue: (issueId) => {
    return get().flights.find((f) => f.issueIds.includes(issueId)) ?? null;
  },

  // === File ownership collision detection ===

  checkFileCollisions: (flightId, _milestoneId, taskId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    if (!flight) return [];
    const allTasks = getAllTasks(flight);
    const thisTask = allTasks.find((t) => t.id === taskId);
    if (!thisTask?.ownedPaths?.length) return [];

    const activeTasks = allTasks.filter(
      (t) =>
        t.id !== taskId &&
        (t.status === "running" || t.status === "queued") &&
        t.ownedPaths?.length,
    );

    const conflicts: string[] = [];
    for (const other of activeTasks) {
      for (const path of thisTask.ownedPaths) {
        if (other.ownedPaths!.some((op) => claimedPathsOverlap(op, path))) {
          conflicts.push(`${path} (owned by "${other.title}")`);
        }
      }
    }
    return conflicts;
  },

  // === Coordination log ===

  addCoordinationEvent: (flightId, event) => {
    set((s) => {
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        const entry: CoordinationEvent = {
          ...event,
          id: generateId("coord"),
          timestamp: Date.now(),
        };
        const log = [...(f.coordinationLog ?? []), entry];
        // Cap at 100 events per flight (drop oldest)
        const capped = log.length > 100 ? log.slice(log.length - 100) : log;
        return { ...f, coordinationLog: capped, updatedAt: Date.now() };
      });
      saveState({ flights, activeFlightId: s.activeFlightId });
      return { flights };
    });
  },

  getCoordinationLog: (flightId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    return flight?.coordinationLog ?? [];
  },

  // === Computed status ===

  computeFlightStatus: (flightId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    if (!flight) return "draft";
    return computeStatus(flight);
  },

  getFlightProgress: (flightId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    if (!flight) return { done: 0, total: 0 };
    const tasks = getAllTasks(flight);
    return {
      done: tasks.filter((t) => t.status === "done").length,
      total: tasks.length,
    };
  },

  getAttentionFlights: () => {
    const { flights } = get();
    return flights.filter((f) => {
      const tasks = getAllTasks(f);
      return tasks.some((t) => t.status === "approval_needed" || t.status === "failed");
    });
  },

  findTaskBySessionId: (sessionId) => {
    if (!sessionId) return null;
    for (const flight of get().flights) {
      for (const milestone of flight.milestones) {
        for (const task of milestone.tasks) {
          if (task.sessionId === sessionId) {
            return { flight, milestone, task };
          }
        }
      }
    }
    return null;
  },

  reconcileIssueLinks: (options = {}) => {
    const persist = options.persist ?? true;
    const touchUpdatedAt = options.touchUpdatedAt ?? true;

    set((s) => {
      const { flights, changed } = reconcileIssueIdsFromIssues(s.flights, touchUpdatedAt);
      if (!changed) return s;
      if (persist) {
        saveState({ flights, activeFlightId: s.activeFlightId });
      }
      return { flights };
    });
  },

  hydrateFromBackend: async (persisted) => {
    try {
      const state = persisted ?? (await loadPersistedState());
      set({
        flights: state.flights,
        activeFlightId: state.ui.selectedFlightId ?? null,
      });
      get().reconcileIssueLinks({ persist: false, touchUpdatedAt: false });
    } catch (err) {
      console.warn("[flightStore.hydrate] swallowed error:", err);
    }
  },

  reconcileLiveSessions: (liveSessionIds) => {
    const liveSet = new Set(liveSessionIds);
    set((s) => {
      let changed = false;
      const flights = s.flights.map((flight) => {
        let flightChanged = false;

        const milestones = flight.milestones.map((milestone) => {
          let milestoneChanged = false;
          const tasks = milestone.tasks.map((task) => {
            if (!task.sessionId) return task;

            if (liveSet.has(task.sessionId)) {
              const nextStatus =
                task.status === "queued" || task.status === "paused"
                  ? ("running" as const)
                  : task.status;
              if (nextStatus !== task.status) {
                changed = true;
                milestoneChanged = true;
                flightChanged = true;
                return { ...task, status: nextStatus };
              }
              return task;
            }

            if (["running", "queued", "approval_needed"].includes(task.status)) {
              changed = true;
              milestoneChanged = true;
              flightChanged = true;
              return { ...task, sessionId: null, status: "paused" as const };
            }

            changed = true;
            milestoneChanged = true;
            flightChanged = true;
            return { ...task, sessionId: null };
          });

          return milestoneChanged ? { ...milestone, tasks } : milestone;
        });

        const linkedSessionIds = Array.from(
          new Set(
            milestones.flatMap((milestone) =>
              milestone.tasks
                .map((task) => task.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
            ),
          ),
        );

        const hasLiveTasks = milestones.some((milestone) =>
          milestone.tasks.some((task) => task.sessionId && liveSet.has(task.sessionId)),
        );

        let status = flight.status;
        if (hasLiveTasks && status !== "done" && status !== "failed" && status !== "cancelled") {
          status = "active";
        } else if (!hasLiveTasks && status === "active") {
          status = "paused";
        }

        if (
          flightChanged ||
          linkedSessionIds.length !== flight.linkedSessionIds.length ||
          linkedSessionIds.some((id, idx) => flight.linkedSessionIds[idx] !== id) ||
          status !== flight.status
        ) {
          changed = true;
          return { ...flight, milestones, linkedSessionIds, status, updatedAt: Date.now() };
        }

        return flight;
      });

      if (changed) {
        saveState({ flights, activeFlightId: s.activeFlightId });
        return { flights };
      }

      return s;
    });
  },
}));
