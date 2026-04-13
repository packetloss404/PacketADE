// === Memory Event Types ===

export type MemoryEventType = "session_completed" | "task_completed" | "flight_completed";

// --- Payloads ---

export interface SessionCompletedPayload {
  sessionId: string;
  agentId: string;
  durationMs: number;
  status: "done" | "error" | "killed";
  summary: string | null;
  filesModified: string[];
  keyDecisions: string[];
}

export interface TaskCompletedPayload {
  taskId: string;
  taskTitle: string;
  flightId: string;
  flightTitle: string;
  milestoneId: string;
  success: boolean;
  exitCode: number | null;
  summary: string;
  filesChanged: string[];
  errors: string[];
  durationMs: number;
}

export interface FlightCompletedPayload {
  flightId: string;
  flightTitle: string;
  summary: string;
  whatWorked: string[];
  whatFailed: string[];
  lessonsLearned: string[];
  suggestedImprovements: string[];
  tags: string[];
}

// --- Event Union ---

interface MemoryEventBase {
  id: string;
  timestamp: number;
  projectPath: string;
}

export type MemoryEvent =
  | (MemoryEventBase & { type: "session_completed"; payload: SessionCompletedPayload })
  | (MemoryEventBase & { type: "task_completed"; payload: TaskCompletedPayload })
  | (MemoryEventBase & { type: "flight_completed"; payload: FlightCompletedPayload });

// --- File Map (manual scan, kept separate) ---

export interface FileMapEntry {
  path: string;
  summary: string;
  lastAnalyzed: number;
}

// --- Top-level Memory State ---

export interface MemoryState {
  events: MemoryEvent[];
  fileMap: FileMapEntry[];
  lastScanAt: number | null;
  scanProjectPath: string | null;
}
