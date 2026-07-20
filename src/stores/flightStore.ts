import { create } from "zustand";
import { generateId as genId } from "@/lib/storage";
import { loadPersistedState, saveFlightsSlice, saveUiSlice } from "@/lib/tauri";
import type { CoordinationEvent, Flight, FlightStatus, Task } from "@/types/flight";
import { useIssueStore } from "@/stores/issueStore";

type FlightState = {
  flights: Flight[];
  activeFlightId: string | null;
};

const generateId = (prefix: string) => genId(prefix);

function loadState(): FlightState {
  // Backend is the sole source of truth; real data arrives via hydrateFromBackend.
  return { flights: [], activeFlightId: null };
}

let persistenceTail: Promise<void> = Promise.resolve();
let latestPersistence: Promise<void> = Promise.resolve();

function saveState(state: FlightState) {
  // Serialize whole-slice writes in the same order as the local mutations that
  // produced them. Flight launch explicitly flushes this queue before asking
  // Rust to append an Attempt, so a freshly-created Flight cannot race its
  // first launch and a delayed older snapshot cannot land afterwards.
  const snapshot = { flights: [...state.flights], activeFlightId: state.activeFlightId };
  const job = persistenceTail.then(() => syncFlightsToBackend(snapshot));
  latestPersistence = job;
  persistenceTail = job.catch((err) => {
    console.warn("[flightStore.persist] swallowed error:", err);
  });
}

async function syncFlightsToBackend(state: FlightState) {
  await saveFlightsSlice(state.flights);
  await saveUiSlice({ selectedFlightId: state.activeFlightId });
}

// === Helpers ===

function getAllTasks(flight: Flight): Task[] {
  return flight.milestones.flatMap((m) => m.tasks);
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
  /** Wait for every Flight mutation queued before this call to reach Rust. */
  flushPersistence: () => Promise<void>;
  /** N2: append a coordination event (task_failed / escalation suggestion / …)
   *  to a flight's timeline, surfaced in FlightsView's coordination log. */
  appendCoordinationEvent: (
    flightId: string,
    event: Omit<CoordinationEvent, "id" | "flightId" | "timestamp">,
  ) => void;
  deleteFlight: (id: string) => void;
  setActiveFlight: (id: string | null) => void;

  // Issue linking
  addIssueToFlight: (flightId: string, issueId: string) => void;
  removeIssueFromFlight: (flightId: string, issueId: string) => void;

  // Computed status
  computeFlightStatus: (flightId: string) => FlightStatus;
  // `issueIds` is a legacy frontend cache; Rust flights do not round-trip it.
  reconcileIssueLinks: (options?: { persist?: boolean; touchUpdatedAt?: boolean }) => void;
  hydrateFromBackend: (persisted?: Awaited<ReturnType<typeof loadPersistedState>>) => Promise<void>;
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

  flushPersistence: () => latestPersistence,

  appendCoordinationEvent: (flightId, event) => {
    set((s) => {
      let changed = false;
      const flights = s.flights.map((f) => {
        if (f.id !== flightId) return f;
        changed = true;
        const full: CoordinationEvent = {
          ...event,
          id: generateId("coord"),
          flightId,
          timestamp: Date.now(),
        };
        return { ...f, coordinationLog: [...(f.coordinationLog ?? []), full] };
      });
      if (!changed) return {};
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

  // === Computed status ===

  computeFlightStatus: (flightId) => {
    const flight = get().flights.find((f) => f.id === flightId);
    if (!flight) return "draft";
    return computeStatus(flight);
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
      // F51: merge rather than wholesale-replace so locally-added optimistic
      // flights not yet in the backend snapshot survive hydration. Backend is
      // authoritative for any id it does contain.
      const backendIds = new Set(state.flights.map((f) => f.id));
      const localOnly = get().flights.filter((f) => !backendIds.has(f.id));
      set({
        flights: [...state.flights, ...localOnly],
        activeFlightId: state.ui.selectedFlightId ?? null,
      });
      get().reconcileIssueLinks({ persist: false, touchUpdatedAt: false });
    } catch (err) {
      console.warn("[flightStore.hydrate] swallowed error:", err);
    }
  },
}));
