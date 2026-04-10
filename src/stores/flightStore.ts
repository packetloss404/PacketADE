import { create } from "zustand";
import { generateId as genId } from "@/lib/storage";
import { loadPersistedState, saveFlightsSlice, saveUiSlice } from "@/lib/tauri";
import type { Flight, FlightStatus, Milestone, Task } from "@/types/flight";
import { useIssueStore } from "@/stores/issueStore";
import { useRoutingStore } from "@/stores/routingStore";

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
  } catch {}
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

function computeStatus(flight: Flight): FlightStatus {
  // If the flight has milestones, derive status from tasks
  if (flight.milestones.length > 0) {
    const tasks = getAllTasks(flight);
    if (tasks.length > 0) {
      if (tasks.some((t) => t.status === "approval_needed")) return "active";
      if (tasks.some((t) => t.status === "failed")) return "failed";
      if (tasks.every((t) => t.status === "done")) return "review";
      if (tasks.some((t) => t.status === "running" || t.status === "queued")) return "active";
      if (tasks.some((t) => t.status === "blocked")) return "active";
    }
  }

  // Legacy issue-based status computation (PacketCode-specific)
  if (flight.issueIds && flight.issueIds.length > 0) {
    const { issues } = useIssueStore.getState();
    const linked = issues.filter((i) => flight.issueIds.includes(i.id));
    if (linked.length > 0) {
      if (linked.some((i) => i.status === "needs_human")) return "paused";
      if (linked.some((i) => i.status === "blocked")) return "paused";
      if (linked.every((i) => i.status === "done")) return "done";
      if (linked.some((i) => i.status === "in_progress" || i.status === "qa")) return "active";
    }
  }

  return flight.status;
}

// === Store ===

interface FlightStore {
  flights: Flight[];
  activeFlightId: string | null;

  // Flight CRUD
  addFlight: (
    flight: Pick<Flight, "title" | "objective" | "priority" | "projectPath"> &
      Partial<Pick<Flight, "gitBranch" | "issueIds">>,
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
    task: Pick<Task, "title" | "description" | "type" | "dependsOn"> & { agentConfigId?: string; model?: string },
  ) => string;
  updateTask: (
    flightId: string,
    milestoneId: string,
    taskId: string,
    updates: Partial<Task>,
  ) => void;
  deleteTask: (flightId: string, milestoneId: string, taskId: string) => void;

  // Session linking
  linkSessionToFlight: (flightId: string, sessionId: string) => void;
  unlinkSessionFromFlight: (flightId: string, sessionId: string) => void;

  // Issue linking
  addIssueToFlight: (flightId: string, issueId: string) => void;
  removeIssueFromFlight: (flightId: string, issueId: string) => void;
  getFlightForIssue: (issueId: string) => Flight | null;

  // Computed status
  computeFlightStatus: (flightId: string) => FlightStatus;
  getFlightProgress: (flightId: string) => { done: number; total: number };
  getAttentionFlights: () => Flight[];
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
      gitBranch: input.gitBranch,
      milestones: [],
      linkedSessionIds: [],
      issueIds: input.issueIds ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
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

  // === Issue linking (PacketCode-specific legacy) ===

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

  hydrateFromBackend: async (persisted) => {
    try {
      const state = persisted ?? (await loadPersistedState());
      set({
        flights: state.flights,
        activeFlightId: state.ui.selectedFlightId ?? null,
      });
    } catch {}
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
