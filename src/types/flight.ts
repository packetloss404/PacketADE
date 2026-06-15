// === Flight Status & Priority ===

export type FlightStatus =
  | "spec"
  | "draft"
  | "planning"
  | "ready"
  | "active"
  | "paused"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type FlightPriority = "low" | "medium" | "high" | "critical";

// === Milestone ===

export type MilestoneStatus = "pending" | "active" | "done" | "failed";

export interface Milestone {
  id: string;
  flightId: string;
  title: string;
  description: string;
  order: number;
  status: MilestoneStatus;
  tasks: Task[];
  validationCriteria: string[];
}

// === Task ===

export type TaskRole = "coordinator" | "builder" | "reviewer" | "scout";

export type TaskStatus =
  | "pending"
  | "blocked"
  | "queued"
  | "running"
  | "approval_needed"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type TaskType =
  | "implementation"
  | "testing"
  | "review"
  | "validation"
  | "research"
  | "refactor"
  | "documentation";

export type ValidationVerdict = "pass" | "fail" | "warn";

export interface TaskHandoff {
  summary: string;
  filesChanged: string[];
  testsNeeded: string[];
  followUps: string[];
}

export interface TaskValidationAssertion {
  label: string;
  status: ValidationVerdict;
  details?: string;
}

export interface TaskValidationReport {
  verdict: ValidationVerdict;
  summary: string;
  assertions: TaskValidationAssertion[];
}

export interface TaskResult {
  exitCode: number | null;
  summary: string;
  filesChanged: string[];
  errors: string[];
  duration: number;
  handoff?: TaskHandoff;
  validation?: TaskValidationReport;
}

export type ReviewType = "tool_call" | "file_write" | "command" | "milestone_gate";

export interface ReviewPacket {
  id: string;
  taskId: string;
  flightId: string;
  milestoneId: string;
  requestedAt: number;
  reviewType: ReviewType;
  summary: string;
  diff?: string;
  command?: string;
  filePaths: string[];
  agentId?: string;
  sessionId?: string;
}

export interface Task {
  id: string;
  milestoneId: string;
  flightId: string;
  title: string;
  description: string;
  order: number;
  status: TaskStatus;
  type: TaskType;
  role?: TaskRole;
  ownedPaths?: string[];
  agentConfigId: string;
  agentArgs?: string[];
  model?: string;
  dependsOn: string[];
  sessionId: string | null;
  blockedReason?: string;
  handoffLog?: TaskHandoff[];
  result?: TaskResult;
  reviewPacket?: ReviewPacket;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  cost: number;
  tokens: number;
  /**
   * Flight Planner: number of `replan_after_failure` calls this task has
   * triggered (excluding RateLimit/Network exemptions). Mirrored from
   * `FlightPlannerSession.replans_per_task` by
   * `FlightPlannerRegistry::bump_replan_count`. Read by the planner's
   * failure-wake body renderer to surface budget headroom (`N / 3`).
   *
   * Optional on the frontend Task because legacy Task constructors and
   * helper factories may not set it; the Rust DTO carries it as a
   * required `replanCount: number` (with `#[serde(default)]` for
   * back-compat with old persisted state).
   */
  replanCount?: number;
}

// === Coordination Events ===

export type CoordinationEventType =
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "handoff"
  | "review_requested"
  | "review_resolved"
  | "collision_warning"
  | "escalation";

export interface CoordinationEvent {
  id: string;
  flightId: string;
  type: CoordinationEventType;
  taskId?: string;
  taskTitle?: string;
  agentId?: string;
  summary: string;
  timestamp: number;
  metadata?: Record<string, string>;
}

// === Async Flight Attempts ===
// An Attempt is one parallel agent session, bound to a git worktree on either
// the local filesystem or a remote SSH host. A Flight in async-mode has
// `attempts.length > 0`; legacy multi-task flights have `milestones[]` instead.

export type AttemptStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export type AttemptTarget =
  | { kind: "local"; basePath: string; worktreePath: string }
  | { kind: "ssh"; targetId: string; basePath: string; worktreePath: string };

export interface Attempt {
  id: string;
  flightId: string;
  target: AttemptTarget;
  agentConfigId: string;
  model: string;
  provider: string;
  branch: string;
  baseBranch: string;
  sessionId: string;
  status: AttemptStatus;
  startedAt?: number;
  completedAt?: number;
  cost: number;
  tokens: number;
  errorMessage?: string;
  /**
   * v0.8-G: PR number of the draft PR opened for this attempt's branch
   * when the parent Flight has `publishAttemptsAsPrs == true`. Undefined
   * when publishing is disabled, the publish step hasn't run yet, or the
   * publish failed (errors are stored in `errorMessage`).
   */
  draftPrNumber?: number;
}

// === Flight ===

export type ApprovalDecisionType = "approved" | "denied" | "force_overridden";

export interface ApprovalDecision {
  id: string;
  reviewPacketId: string;
  taskId: string;
  flightId: string;
  decision: ApprovalDecisionType;
  decidedAt: number;
  reason?: string;
}

export interface Flight {
  id: string;
  title: string;
  objective: string;
  status: FlightStatus;
  priority: FlightPriority;
  projectPath: string;
  workspaceId: string | null;
  gitBranch?: string;
  milestones: Milestone[];
  linkedSessionIds: string[];
  /** Legacy issue linking (PacketADE-specific) */
  issueIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  coordinationLog?: CoordinationEvent[];
  totalCost: number;
  totalTokens: number;
  /** The single user prompt for an async-mode Flight. */
  prompt?: string;
  /** Parallel agent attempts. Non-empty = async-mode Flight. */
  attempts?: Attempt[];
  // Flight Planner (E1+) — autonomous planner session bound to this Flight.
  plannerSessionId?: string;
  plannerStatus?: "idle" | "awake" | "paused" | "quota_paused" | "completed" | "failed";
  plannerCost?: number;
  plannerTokens?: number;
  /**
   * Identifies which planner backend provider was used for cost/token
   * accounting on this Flight. E1 populates this when the planner session
   * starts; today the values are `"claude-oauth"` (Anthropic OAuth via the
   * sidecar / Agent SDK) or `"api-claude"` (Anthropic API via the in-process
   * LlmProvider). The StatGrid uses this to decide whether the planner
   * dollar value is best-effort (OAuth: no public quota endpoint, surface
   * cumulative tokens as the authoritative measure) or fully reliable (API:
   * priced per-token by us). Optional because legacy persisted Flights
   * created before E8-ACCUM landed don't carry the field.
   */
  plannerProvider?: string;
  /**
   * v0.8-G: when true on an async-mode Flight, the executor pipeline
   * pushes each attempt's branch to origin and opens a draft GitHub PR
   * after the attempt reaches a terminal state. The resulting PR number
   * is written back to `Attempt.draftPrNumber`. Defaults to false for
   * back-compat with previously-persisted Flights.
   */
  publishAttemptsAsPrs?: boolean;
}
