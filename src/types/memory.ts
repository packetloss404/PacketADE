// === Memory System Types ===
// The memory system captures events, auto-summarizes sessions,
// extracts reusable patterns, and injects live context into workspaces.

export type MemoryEventType =
  | "session_completed"
  | "task_completed"
  | "flight_completed"
  | "manual_note";

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

// v0.8-D — manual capture from any UI surface (initial caller is GitHub
// "Save as memory"). Free-form note tagged with a source string so we can
// filter / surface by origin later.
export interface ManualNotePayload {
  source: string;
  summary: string;
  body: string;
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
  | (MemoryEventBase & { type: "flight_completed"; payload: FlightCompletedPayload })
  | (MemoryEventBase & { type: "manual_note"; payload: ManualNotePayload });

// --- Learned Patterns (extracted from session summaries) ---

export type PatternCategory = "architecture" | "convention" | "preference" | "pitfall";

export interface LearnedPattern {
  id: string;
  pattern: string;
  category: PatternCategory;
  confidence: number;
  extractedAt: number;
  /** v0.8-H: project this pattern was learned in. Optional for
   * back-compat with patterns extracted before the field existed —
   * legacy entries are treated as "global" and match every project. */
  projectPath?: string;
  /** v0.8-H: pinned patterns sort first in the injected context and
   * are exempt from the `capPatterns` confidence-based eviction. */
  pinned?: boolean;
}

// --- Top-level Memory State ---

export interface MemoryState {
  events: MemoryEvent[];
  patterns: LearnedPattern[];
  lastPatternRefreshAt: number | null;
  summariesSinceLastRefresh: number;
}
