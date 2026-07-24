import type { Attempt, Flight, Task, TaskStatus } from "@/types/flight";

export interface FlightAttentionSummary {
  /** Attempts awaiting the user's Accept/Reject. */
  reviewing: Attempt[];
  /** Failed attempts — candidates for reassign or manual review. */
  failed: Attempt[];
  /** reviewing + failed. */
  total: number;
}

/**
 * E6: the single "needs a human" list for a flight — attempts that are either
 * awaiting review (`reviewing`) or failed (candidates for reassign/review).
 * Healthy (running/completed) and cancelled attempts never need intervention.
 */
export function summarizeFlightAttention(flight: Flight): FlightAttentionSummary {
  const attempts = flight.attempts ?? [];
  const reviewing = attempts.filter((a) => a.status === "reviewing");
  const failed = attempts.filter((a) => a.status === "failed");
  return { reviewing, failed, total: reviewing.length + failed.length };
}

export interface FlightReviewTaskRef {
  flightId: string;
  flightTitle: string;
  milestoneId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  agentConfigId: string;
  sessionId?: string;
  attemptId?: string;
  reviewPacketId?: string;
  filePath: string;
  relation: "reported" | "owned";
}

export interface FlightReviewSummary {
  taskCount: number;
  reportedFileCount: number;
  ownedFileCount: number;
  pendingApprovalCount: number;
  files: FlightReviewTaskRef[];
}

export interface GitFlightReviewMatch {
  path: string;
  refs: FlightReviewTaskRef[];
}

export interface GitFlightReviewContext {
  linkedFileCount: number;
  taskCount: number;
  pendingApprovalCount: number;
  flightIds: string[];
  matchesByPath: Map<string, GitFlightReviewMatch>;
}

export interface FlightReviewSelector {
  flightId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
}

export interface FlightReviewSelection {
  files: FlightReviewTaskRef[];
  flightIds: string[];
  taskIds: string[];
  attemptIds: string[];
  hasAttemptWithoutFileData: boolean;
}

function normalizeRepoPath(path: string, projectPath?: string): string {
  const root = projectPath ? normalizeRepoPath(projectPath) : "";
  const normalized = normalizeRepoPathValue(path);
  if (root && normalized === root) return "";
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

function normalizeRepoPathValue(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function addUnique(paths: Set<string>, next?: string[] | null) {
  for (const path of next ?? []) {
    const trimmed = path.trim();
    if (trimmed) paths.add(trimmed);
  }
}

export function collectTaskReportedFiles(task: Task): string[] {
  const paths = new Set<string>();
  addUnique(paths, task.result?.filesChanged);
  addUnique(paths, task.result?.handoff?.filesChanged);
  addUnique(paths, task.reviewPacket?.filePaths);
  for (const handoff of task.handoffLog ?? []) {
    addUnique(paths, handoff.filesChanged);
  }
  return [...paths];
}

export function summarizeFlightReview(flight: Flight): FlightReviewSummary {
  const files: FlightReviewTaskRef[] = [];
  const seenTasks = new Set<string>();
  let pendingApprovalCount = 0;
  let reportedFileCount = 0;
  let ownedFileCount = 0;

  for (const milestone of flight.milestones) {
    for (const task of milestone.tasks) {
      if (task.status === "approval_needed") pendingApprovalCount += 1;
      const reported = collectTaskReportedFiles(task);
      const owned = task.ownedPaths ?? [];
      if (reported.length > 0 || owned.length > 0) seenTasks.add(task.id);

      for (const filePath of reported) {
        reportedFileCount += 1;
        files.push(taskRef(flight, task, filePath, "reported"));
      }
      for (const filePath of owned) {
        ownedFileCount += 1;
        files.push(taskRef(flight, task, filePath, "owned"));
      }
    }
  }

  return {
    taskCount: seenTasks.size,
    reportedFileCount,
    ownedFileCount,
    pendingApprovalCount,
    files,
  };
}

export function matchGitFilesToFlightTasks(
  changedPaths: string[],
  flights: Flight[],
  context: { projectPath?: string; workspaceId?: string | null } = {},
): GitFlightReviewContext {
  const relevantFlights = flights.filter((flight) => {
    if (context.workspaceId && flight.workspaceId === context.workspaceId) return true;
    if (!context.projectPath) return false;
    return normalizeRepoPath(flight.projectPath) === normalizeRepoPath(context.projectPath);
  });

  const matchesByPath = new Map<string, GitFlightReviewMatch>();
  const matchedTasks = new Set<string>();
  const flightIds = new Set<string>();
  let pendingApprovalCount = 0;

  const refs = relevantFlights.flatMap((flight) => {
    const summary = summarizeFlightReview(flight);
    pendingApprovalCount += summary.pendingApprovalCount;
    return summary.files;
  });

  for (const changedPath of changedPaths) {
    const normalizedChanged = normalizeRepoPath(changedPath, context.projectPath);
    if (!normalizedChanged) continue;
    const matches = refs.filter((ref) => {
      const normalizedRef = normalizeRepoPath(ref.filePath, context.projectPath);
      if (!normalizedRef) return false;
      if (ref.relation === "reported") return normalizedRef === normalizedChanged;
      return (
        normalizedRef === normalizedChanged ||
        normalizedChanged.startsWith(`${normalizedRef}/`) ||
        normalizedRef.startsWith(`${normalizedChanged}/`)
      );
    });
    if (matches.length === 0) continue;
    const deduped = dedupeRefs(matches);
    for (const ref of deduped) {
      matchedTasks.add(ref.taskId);
      flightIds.add(ref.flightId);
    }
    matchesByPath.set(normalizedChanged, { path: changedPath, refs: deduped });
  }

  return {
    linkedFileCount: matchesByPath.size,
    taskCount: matchedTasks.size,
    pendingApprovalCount,
    flightIds: [...flightIds],
    matchesByPath,
  };
}

export function flightReviewKey(path: string): string {
  return normalizeRepoPath(path);
}

export function selectFlightReviewFiles(
  flights: Flight[],
  selector: FlightReviewSelector,
): FlightReviewSelection {
  const wantedSessionId = selector.sessionId ?? selector.conversationId ?? null;
  const files: FlightReviewTaskRef[] = [];
  const flightIds = new Set<string>();
  const taskIds = new Set<string>();
  const attemptIds = new Set<string>();
  let sawSelectedAttempt = false;
  let selectedAttemptHasTaskData = false;

  for (const flight of flights) {
    if (selector.flightId && flight.id !== selector.flightId) continue;

    const selectedAttempts = (flight.attempts ?? []).filter((attempt) => {
      if (selector.attemptId && attempt.id === selector.attemptId) return true;
      return Boolean(wantedSessionId && attempt.sessionId === wantedSessionId);
    });
    if (selectedAttempts.length > 0) {
      sawSelectedAttempt = true;
      flightIds.add(flight.id);
      for (const attempt of selectedAttempts) attemptIds.add(attempt.id);
    }

    for (const milestone of flight.milestones) {
      for (const task of milestone.tasks) {
        const taskAttempt = attemptForTask(flight, task);
        const sessionId = task.reviewPacket?.sessionId ?? task.sessionId;
        const matchesTask =
          (selector.taskId && task.id === selector.taskId) ||
          (wantedSessionId && sessionId === wantedSessionId) ||
          Boolean(selector.attemptId && taskAttempt?.id === selector.attemptId);

        if (!matchesTask) continue;

        const refs = taskReviewRefs(flight, task);
        files.push(...refs);
        flightIds.add(flight.id);
        taskIds.add(task.id);
        if (taskAttempt) {
          attemptIds.add(taskAttempt.id);
          if (refs.length > 0) selectedAttemptHasTaskData = true;
        }
      }
    }
  }

  return {
    files: dedupeRefs(files),
    flightIds: [...flightIds],
    taskIds: [...taskIds],
    attemptIds: [...attemptIds],
    hasAttemptWithoutFileData:
      sawSelectedAttempt && !selectedAttemptHasTaskData && files.length === 0,
  };
}

function taskRef(
  flight: Flight,
  task: Task,
  filePath: string,
  relation: FlightReviewTaskRef["relation"],
): FlightReviewTaskRef {
  return {
    flightId: flight.id,
    flightTitle: flight.title || "Untitled flight",
    milestoneId: task.milestoneId,
    taskId: task.id,
    taskTitle: task.title || "Untitled task",
    taskStatus: task.status,
    agentConfigId: task.agentConfigId || "agent",
    sessionId: task.reviewPacket?.sessionId ?? task.sessionId ?? undefined,
    attemptId: attemptForTask(flight, task)?.id,
    reviewPacketId: task.reviewPacket?.id,
    filePath,
    relation,
  };
}

function taskReviewRefs(flight: Flight, task: Task): FlightReviewTaskRef[] {
  return [
    ...collectTaskReportedFiles(task).map((filePath) =>
      taskRef(flight, task, filePath, "reported"),
    ),
    ...(task.ownedPaths ?? []).map((filePath) => taskRef(flight, task, filePath, "owned")),
  ];
}

function attemptForTask(flight: Flight, task: Task) {
  const sessionId = task.reviewPacket?.sessionId ?? task.sessionId;
  if (!sessionId) return undefined;
  return flight.attempts?.find((attempt) => attempt.sessionId === sessionId);
}

function dedupeRefs(refs: FlightReviewTaskRef[]): FlightReviewTaskRef[] {
  const seen = new Set<string>();
  const out: FlightReviewTaskRef[] = [];
  for (const ref of refs) {
    const key = `${ref.flightId}:${ref.taskId}:${ref.filePath}:${ref.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
