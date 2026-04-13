import { create } from "zustand";
import {
  saveMemorySlice,
  summarizeSession,
  extractPatterns,
  readPtyTranscript,
} from "@/lib/tauri";
import { parseJsonFromResponse, generateId } from "@/lib/storage";
import type {
  MemoryEvent,
  MemoryEventType,
  LearnedPattern,
  SessionCompletedPayload,
  TaskCompletedPayload,
  FlightCompletedPayload,
} from "@/types/memory";
import type { loadPersistedState } from "@/lib/tauri";

const MAX_EVENTS = 200;
const PATTERN_REFRESH_THRESHOLD = 3;
const MAX_PATTERNS = 20;
const CONTEXT_MAX_PATTERNS = 10;
const CONTEXT_MAX_SESSIONS = 5;
const CONTEXT_MAX_LESSONS = 5;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

interface MemoryStore {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  lastPatternRefreshAt: number | null;
  summariesSinceLastRefresh: number;
  isLearning: boolean;
  learningStatus: string | null;

  // Hydration
  hydrateFromBackend: (persisted: Awaited<ReturnType<typeof loadPersistedState>>) => void;

  // Auto-capture (called from session/task/flight lifecycle)
  captureSessionCompleted: (payload: SessionCompletedPayload, projectPath: string) => void;
  captureTaskCompleted: (payload: TaskCompletedPayload, projectPath: string) => void;
  captureFlightCompleted: (payload: FlightCompletedPayload, projectPath: string) => void;

  // Auto-learning: summarize a session transcript and store the result
  learnFromSession: (sessionId: string, agentId: string, projectPath: string, durationMs: number) => Promise<void>;

  // Manual pattern refresh
  refreshPatterns: (projectPath: string) => Promise<void>;

  // Cleanup
  deleteEvent: (id: string) => void;
  deletePattern: (id: string) => void;
  clearMemory: () => void;

  // Context injection (live, not snapshot)
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

async function persistState(events: MemoryEvent[], patterns?: LearnedPattern[]) {
  try {
    await saveMemorySlice(events, patterns);
  } catch {
    // Non-fatal: state is still in memory
  }
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  events: [],
  patterns: [],
  lastPatternRefreshAt: null,
  summariesSinceLastRefresh: 0,
  isLearning: false,
  learningStatus: null,

  hydrateFromBackend: (persisted) => {
    const events = (persisted.memoryEvents ?? []) as MemoryEvent[];
    const patterns = (persisted.memoryPatterns ?? []) as LearnedPattern[];
    set({ events, patterns });
  },

  captureSessionCompleted: (payload, projectPath) => {
    const event = createEvent("session_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  captureTaskCompleted: (payload, projectPath) => {
    const event = createEvent("task_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  captureFlightCompleted: (payload, projectPath) => {
    const event = createEvent("flight_completed", projectPath, payload);
    const events = capEvents([...get().events, event]);
    set({ events });
    void persistState(events, get().patterns);
  },

  learnFromSession: async (sessionId, agentId, projectPath, durationMs) => {
    if (get().isLearning) return; // don't stack concurrent learning calls

    set({ isLearning: true, learningStatus: "Reading session transcript..." });

    try {
      // 1. Read the PTY transcript
      const transcript = await readPtyTranscript(sessionId);
      if (!transcript?.data?.trim()) {
        set({ isLearning: false, learningStatus: null });
        return;
      }

      // Trim transcript to last ~4000 chars to avoid blowing up the LLM call
      const trimmedTranscript = transcript.data.length > 4000
        ? transcript.data.slice(-4000)
        : transcript.data;

      // 2. Summarize the session
      set({ learningStatus: "Summarizing session..." });
      const summaryResult = await summarizeSession(projectPath, trimmedTranscript);
      const parsed = parseJsonFromResponse(summaryResult) as {
        summary: string;
        keyDecisions: string[];
        filesModified: string[];
      };

      if (!parsed?.summary) {
        set({ isLearning: false, learningStatus: null });
        return;
      }

      // 3. Store the summarized event
      const event = createEvent("session_completed", projectPath, {
        sessionId,
        agentId,
        durationMs,
        status: "done",
        summary: parsed.summary,
        filesModified: parsed.filesModified ?? [],
        keyDecisions: parsed.keyDecisions ?? [],
      });
      const events = capEvents([...get().events, event]);
      const count = get().summariesSinceLastRefresh + 1;
      set({ events, summariesSinceLastRefresh: count });

      // 4. Auto-extract patterns if threshold met
      if (count >= PATTERN_REFRESH_THRESHOLD) {
        set({ learningStatus: "Extracting patterns..." });
        await get().refreshPatterns(projectPath);
      }

      set({ isLearning: false, learningStatus: null });
      void persistState(get().events, get().patterns);
    } catch (e) {
      console.warn("Memory learning failed:", e);
      set({ isLearning: false, learningStatus: null });
    }
  },

  refreshPatterns: async (projectPath) => {
    const { events } = get();
    const normalizedPath = normalizePath(projectPath);

    // Collect session summaries for this project
    const summaries = events
      .filter(
        (e): e is Extract<MemoryEvent, { type: "session_completed" }> =>
          e.type === "session_completed" &&
          normalizePath(e.projectPath) === normalizedPath &&
          e.payload.summary !== null,
      )
      .slice(-10) // last 10 summarized sessions
      .map((e) => e.payload.summary)
      .join("\n---\n");

    if (!summaries.trim()) return;

    try {
      const result = await extractPatterns(projectPath, summaries);
      const parsed = parseJsonFromResponse(result) as {
        pattern: string;
        category: string;
        confidence: number;
      }[];

      if (!Array.isArray(parsed)) return;

      const newPatterns: LearnedPattern[] = parsed
        .filter((p) => p.pattern && p.confidence >= 0.5)
        .slice(0, MAX_PATTERNS)
        .map((p) => ({
          id: generateId("pat"),
          pattern: p.pattern,
          category: (p.category as LearnedPattern["category"]) ?? "convention",
          confidence: p.confidence,
          extractedAt: Date.now(),
        }));

      set({
        patterns: newPatterns,
        lastPatternRefreshAt: Date.now(),
        summariesSinceLastRefresh: 0,
      });
      void persistState(get().events, newPatterns);
    } catch (e) {
      console.warn("Pattern extraction failed:", e);
    }
  },

  deleteEvent: (id) => {
    const events = get().events.filter((e) => e.id !== id);
    set({ events });
    void persistState(events, get().patterns);
  },

  deletePattern: (id) => {
    const patterns = get().patterns.filter((p) => p.id !== id);
    set({ patterns });
    void persistState(get().events, patterns);
  },

  clearMemory: () => {
    set({
      events: [],
      patterns: [],
      lastPatternRefreshAt: null,
      summariesSinceLastRefresh: 0,
    });
    void persistState([], []);
  },

  getContextForSession: (currentProjectPath: string) => {
    if (!currentProjectPath) return "";

    const normalizedCurrent = normalizePath(currentProjectPath);
    const { events, patterns } = get();

    const lines: string[] = [];

    // 1. Learned patterns (highest value — these are distilled knowledge)
    const relevantPatterns = patterns
      .filter((p) => p.confidence >= 0.6)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, CONTEXT_MAX_PATTERNS);

    if (relevantPatterns.length > 0) {
      lines.push("## Learned Patterns");
      relevantPatterns.forEach((p) =>
        lines.push(`- [${p.category}] ${p.pattern}`),
      );
      lines.push("");
    }

    // 2. Lessons from flight retrospectives
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
    const lessons = events
      .filter(
        (e): e is Extract<MemoryEvent, { type: "flight_completed" }> =>
          e.type === "flight_completed" &&
          normalizePath(e.projectPath) === normalizedCurrent &&
          e.timestamp > cutoff,
      )
      .flatMap((e) => e.payload.lessonsLearned)
      .slice(0, CONTEXT_MAX_LESSONS);

    if (lessons.length > 0) {
      lines.push("## Lessons from Previous Flights");
      lessons.forEach((l) => lines.push(`- ${l}`));
      lines.push("");
    }

    // 3. Recent session summaries (last 48h, this project only)
    const sessionCutoff = Date.now() - 48 * 60 * 60 * 1000;
    const sessions = events
      .filter(
        (e): e is Extract<MemoryEvent, { type: "session_completed" }> =>
          e.type === "session_completed" &&
          normalizePath(e.projectPath) === normalizedCurrent &&
          e.timestamp > sessionCutoff &&
          e.payload.summary !== null,
      )
      .slice(-CONTEXT_MAX_SESSIONS);

    if (sessions.length > 0) {
      lines.push("## Recent Session Context");
      sessions.forEach((e) => lines.push(`- ${e.payload.summary}`));
      lines.push("");
    }

    return lines.join("\n");
  },
}));
