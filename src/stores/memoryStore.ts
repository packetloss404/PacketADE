import { create } from "zustand";
import { scanCodebaseMemory, saveMemorySlice } from "@/lib/tauri";
import { parseJsonFromResponse, generateId } from "@/lib/storage";
import type {
  MemoryEvent,
  MemoryEventType,
  FileMapEntry,
  SessionCompletedPayload,
  TaskCompletedPayload,
  FlightCompletedPayload,
} from "@/types/memory";
import type { loadPersistedState } from "@/lib/tauri";

const MAX_EVENTS = 500;

/** Normalize a project path so case / slash differences don't cause false mismatches. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

interface MemoryStore {
  events: MemoryEvent[];
  fileMap: FileMapEntry[];
  lastScanAt: number | null;
  scanProjectPath: string | null;
  isScanning: boolean;
  scanError: string | null;

  // Hydration
  hydrateFromBackend: (persisted: Awaited<ReturnType<typeof loadPersistedState>>) => void;

  // Auto-capture
  captureSessionCompleted: (payload: SessionCompletedPayload, projectPath: string) => void;
  captureTaskCompleted: (payload: TaskCompletedPayload, projectPath: string) => void;
  captureFlightCompleted: (payload: FlightCompletedPayload, projectPath: string) => void;

  // Manual actions
  scanCodebase: (projectPath: string) => Promise<void>;
  deleteEvent: (id: string) => void;
  clearMemory: () => void;

  // Context injection
  getContextForSession: (currentProjectPath: string) => string;
}

function createEvent<T extends MemoryEventType>(
  type: T,
  projectPath: string,
  payload: T extends "session_completed"
    ? SessionCompletedPayload
    : T extends "task_completed"
      ? TaskCompletedPayload
      : FlightCompletedPayload,
): MemoryEvent {
  return {
    id: generateId("mem"),
    type,
    timestamp: Date.now(),
    projectPath,
    payload,
  } as MemoryEvent;
}

function capEvents(events: MemoryEvent[]): MemoryEvent[] {
  if (events.length <= MAX_EVENTS) return events;
  return events.slice(events.length - MAX_EVENTS);
}

async function persistEvents(events: MemoryEvent[]) {
  try {
    await saveMemorySlice(events);
  } catch {
    // Non-fatal: events are still in memory, will persist next time
  }
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  events: [],
  fileMap: [],
  lastScanAt: null,
  scanProjectPath: null,
  isScanning: false,
  scanError: null,

  hydrateFromBackend: (persisted) => {
    const events = (persisted.memoryEvents ?? []) as MemoryEvent[];
    set({ events });
  },

  captureSessionCompleted: (payload, projectPath) => {
    const event = createEvent("session_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistEvents(events);
  },

  captureTaskCompleted: (payload, projectPath) => {
    const event = createEvent("task_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistEvents(events);
  },

  captureFlightCompleted: (payload, projectPath) => {
    const event = createEvent("flight_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistEvents(events);
  },

  scanCodebase: async (projectPath) => {
    set({ isScanning: true, scanError: null });
    try {
      const result = await scanCodebaseMemory(projectPath);
      const parsed = parseJsonFromResponse(result) as {
        path: string;
        summary: string;
      }[];
      const fileMap: FileMapEntry[] = parsed.map((e) => ({
        path: e.path,
        summary: e.summary,
        lastAnalyzed: Date.now(),
      }));
      set({
        fileMap,
        lastScanAt: Date.now(),
        scanProjectPath: projectPath,
        isScanning: false,
      });
    } catch (e) {
      set({ scanError: String(e), isScanning: false });
    }
  },

  deleteEvent: (id) => {
    const events = get().events.filter((e) => e.id !== id);
    set({ events });
    void persistEvents(events);
  },

  clearMemory: () => {
    set({
      events: [],
      fileMap: [],
      lastScanAt: null,
      scanProjectPath: null,
    });
    void persistEvents([]);
  },

  getContextForSession: (currentProjectPath: string) => {
    if (!currentProjectPath) return "";

    const normalizedCurrent = normalizePath(currentProjectPath);
    const { events, fileMap, scanProjectPath } = get();

    // Filter events for this project, last 48h or last 10
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const relevant = events
      .filter(
        (e) =>
          normalizePath(e.projectPath) === normalizedCurrent &&
          e.timestamp > cutoff,
      )
      .slice(-10);

    const lines: string[] = [];

    // Lessons from flight retrospectives
    const lessons = relevant
      .filter((e): e is Extract<MemoryEvent, { type: "flight_completed" }> => e.type === "flight_completed")
      .flatMap((e) => e.payload.lessonsLearned);
    if (lessons.length > 0) {
      lines.push("## Lessons from Previous Flights");
      lessons.forEach((l) => lines.push(`- ${l}`));
      lines.push("");
    }

    // Recent session summaries
    const sessions = relevant.filter(
      (e): e is Extract<MemoryEvent, { type: "session_completed" }> =>
        e.type === "session_completed" && e.payload.summary !== null,
    );
    if (sessions.length > 0) {
      lines.push("## Recent Session Context");
      sessions.forEach((e) => lines.push(`- ${e.payload.summary}`));
      lines.push("");
    }

    // File map
    if (
      fileMap.length > 0 &&
      scanProjectPath &&
      normalizePath(scanProjectPath) === normalizedCurrent
    ) {
      lines.push("## Key Files");
      fileMap.slice(0, 20).forEach((f) => lines.push(`- ${f.path}: ${f.summary}`));
      lines.push("");
    }

    return lines.join("\n");
  },
}));
