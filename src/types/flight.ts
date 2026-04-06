// === Flight Status & Priority ===

export type FlightStatus =
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
  agentConfigId: string;
  agentArgs?: string[];
  model?: string;
  dependsOn: string[];
  sessionId: string | null;
  result?: TaskResult;
  reviewPacket?: ReviewPacket;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  cost: number;
  tokens: number;
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
  gitBranch?: string;
  milestones: Milestone[];
  linkedSessionIds: string[];
  /** Legacy issue linking (PacketCode-specific) */
  issueIds: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  totalCost: number;
  totalTokens: number;
}
