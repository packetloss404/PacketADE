import { generateId } from "@/lib/storage";
import {
  evaluateAutonomyAction,
  pauseAutonomyForRestart,
  validateAutonomyPolicy,
  type AutonomyEvaluationRequest,
} from "@/lib/autonomyPolicy";
import { selectReadyCooperativeTasks } from "@/lib/cooperativeFlight";
import { useAgentTaskStore } from "@/stores/agentTaskStore";
import { useAsyncFlightStore } from "@/stores/asyncFlightStore";
import { useFlightStore } from "@/stores/flightStore";
import type {
  Attempt,
  AutonomyActionKind,
  AutonomyActionRecord,
  AutonomyRuntime,
  Flight,
} from "@/types/flight";

const ACTION_HISTORY_LIMIT = 500;
const activeActions = new Set<string>();
let unsubscribeFlight: (() => void) | null = null;
let unsubscribeAgents: (() => void) | null = null;
let syncRequested = false;
let syncRunning = false;

function currentFlight(flightId: string): Flight | undefined {
  return useFlightStore.getState().flights.find((flight) => flight.id === flightId);
}

function updateRuntime(
  flightId: string,
  update: (runtime: AutonomyRuntime) => AutonomyRuntime,
): void {
  const flight = currentFlight(flightId);
  if (!flight?.autonomyRuntime) return;
  useFlightStore.getState().updateFlight(flightId, {
    autonomyRuntime: update(flight.autonomyRuntime),
  });
}

function appendAction(flightId: string, record: AutonomyActionRecord): void {
  updateRuntime(flightId, (runtime) => ({
    ...runtime,
    actionHistory: [...runtime.actionHistory, record].slice(-ACTION_HISTORY_LIMIT),
  }));
}

function patchAction(
  flightId: string,
  actionId: string,
  patch: Partial<AutonomyActionRecord>,
): void {
  updateRuntime(flightId, (runtime) => ({
    ...runtime,
    actionHistory: runtime.actionHistory.map((record) =>
      record.id === actionId ? { ...record, ...patch } : record,
    ),
  }));
}

function stopForAttention(flightId: string, reason: string): void {
  const flight = currentFlight(flightId);
  if (!flight?.autonomyRuntime || flight.autonomyRuntime.status === "needs_attention") return;
  useFlightStore.getState().updateFlight(flightId, {
    status: "paused",
    autonomyRuntime: {
      ...flight.autonomyRuntime,
      status: "needs_attention",
      pausedAt: Date.now(),
      hardStopReason: reason,
    },
  });
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "escalation",
    agentId: "packetade:bounded-autonomy",
    summary: `Bounded autonomy stopped: ${reason}`,
    metadata: { source: "bounded_autonomy", hardStop: "true" },
  });
}

function targetForAttempt(attempt: Attempt): string {
  return attempt.target.kind === "ssh" ? attempt.target.serverId : "local";
}

function rootForAttempt(attempt: Attempt): string {
  return attempt.target.basePath;
}

function activeAgentCount(flight: Flight): number {
  return (flight.attempts ?? []).filter((attempt) =>
    ["queued", "provisioning", "running"].includes(attempt.status),
  ).length;
}

async function performAutonomyAction(
  flightId: string,
  request: AutonomyEvaluationRequest,
  callback: () => Promise<void>,
  metadata?: AutonomyActionRecord["metadata"],
): Promise<boolean> {
  const key = `${flightId}:${request.action}:${request.subjectId ?? "flight"}`;
  if (activeActions.has(key)) return false;
  const flight = currentFlight(flightId);
  if (!flight) return false;
  const decision = evaluateAutonomyAction(flight, request);
  if (!decision.allowed) {
    if (decision.hardStop) stopForAttention(flightId, decision.reason);
    return false;
  }
  activeActions.add(key);
  const actionId = generateId("autonomy");
  appendAction(flightId, {
    id: actionId,
    kind: request.action,
    subjectId: request.subjectId,
    status: "started",
    reason: decision.reason,
    timestamp: Date.now(),
    cost: flight.totalCost,
    metadata,
  });
  try {
    await callback();
    patchAction(flightId, actionId, {
      status: "completed",
      reason: "Completed through the same action used by Assisted mode.",
      cost: currentFlight(flightId)?.totalCost ?? flight.totalCost,
    });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    patchAction(flightId, actionId, { status: "failed", reason });
    stopForAttention(flightId, reason);
    return false;
  } finally {
    activeActions.delete(key);
  }
}

function recoveryKey(attempt: Attempt): string {
  return (
    attempt.taskId ??
    `${targetForAttempt(attempt)}:${attempt.target.basePath}:${attempt.agentConfigId}`
  );
}

function latestAttemptsByRecoveryKey(flight: Flight): Attempt[] {
  const latest = new Map<string, Attempt>();
  for (const attempt of flight.attempts ?? []) {
    const key = recoveryKey(attempt);
    const previous = latest.get(key);
    if (!previous || (attempt.startedAt ?? 0) >= (previous.startedAt ?? 0)) {
      latest.set(key, attempt);
    }
  }
  return Array.from(latest.values());
}

function completedAction(
  flight: Flight,
  kind: AutonomyActionKind,
  subjectId: string,
  metadataKey?: string,
  metadataValue?: string,
): AutonomyActionRecord | undefined {
  return [...(flight.autonomyRuntime?.actionHistory ?? [])]
    .reverse()
    .find(
      (record) =>
        record.kind === kind &&
        record.subjectId === subjectId &&
        record.status === "completed" &&
        (!metadataKey || record.metadata?.[metadataKey] === metadataValue),
    );
}

async function syncToolPosture(flight: Flight): Promise<void> {
  const posture = flight.autonomyPolicy?.toolPosture;
  if (!posture) return;
  for (const attempt of flight.attempts ?? []) {
    if (!["queued", "provisioning", "running"].includes(attempt.status)) continue;
    if (completedAction(flight, "set_tool_posture", attempt.id)) continue;
    const conversation = useAgentTaskStore
      .getState()
      .conversations.find((item) => item.id === attempt.sessionId);
    if (!conversation) continue;
    const permissionMode = posture === "allow_in_project" ? "auto" : "ask_for_risky";
    if (conversation.permissionMode === permissionMode) {
      appendAction(flight.id, {
        id: generateId("autonomy"),
        kind: "set_tool_posture",
        subjectId: attempt.id,
        status: "completed",
        reason: `Tool posture already matched ${posture}.`,
        timestamp: Date.now(),
        cost: flight.totalCost,
        metadata: { posture },
      });
      continue;
    }
    await performAutonomyAction(
      flight.id,
      {
        action: "set_tool_posture",
        subjectId: attempt.id,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
      },
      () => useAgentTaskStore.getState().setPermissionMode(attempt.sessionId, permissionMode),
      { posture },
    );
  }
}

async function syncRecovery(flight: Flight): Promise<void> {
  if (!flight.autonomyPolicy?.autoRecovery) return;
  for (const attempt of latestAttemptsByRecoveryKey(flight)) {
    if (attempt.status !== "failed") continue;
    const subjectId = recoveryKey(attempt);
    await performAutonomyAction(
      flight.id,
      {
        action: "recover_attempt",
        subjectId,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
        activeAgents: activeAgentCount(currentFlight(flight.id) ?? flight),
      },
      () =>
        useAsyncFlightStore
          .getState()
          .reassignAttempt(flight.id, attempt.id, attempt.agentConfigId),
      { failedAttemptId: attempt.id },
    );
    if (currentFlight(flight.id)?.autonomyRuntime?.status !== "running") return;
  }
}

async function syncReview(flight: Flight): Promise<void> {
  if (!flight.autonomyPolicy?.autoReviewRemediation) return;
  for (const attempt of flight.attempts ?? []) {
    if (attempt.status !== "reviewing") continue;
    const gate = attempt.reviewGate;
    if (!gate) continue;
    const reviewerConversationId = gate.reviewerConversationId ?? "pending";
    if (gate.status === "passed") {
      const action: AutonomyActionKind =
        flight.executionMode === "cooperative" ? "integrate_attempt" : "accept_review_pass";
      await performAutonomyAction(
        flight.id,
        {
          action,
          subjectId: attempt.id,
          root: rootForAttempt(attempt),
          targetId: targetForAttempt(attempt),
        },
        () => useAsyncFlightStore.getState().setAttemptStatus(flight.id, attempt.id, "completed"),
        { reviewerConversationId },
      );
      continue;
    }
    if (gate.status === "error") {
      if (
        completedAction(
          flight,
          "retry_review",
          attempt.id,
          "reviewerConversationId",
          reviewerConversationId,
        )
      ) {
        continue;
      }
      await performAutonomyAction(
        flight.id,
        {
          action: "retry_review",
          subjectId: attempt.id,
          root: rootForAttempt(attempt),
          targetId: targetForAttempt(attempt),
        },
        () => useAsyncFlightStore.getState().retryReviewGate(flight.id, attempt.id),
        { reviewerConversationId },
      );
      continue;
    }
    if (!["changes_requested", "blocked"].includes(gate.status) || !gate.report) continue;
    const remediation = completedAction(
      flight,
      "review_remediation",
      attempt.id,
      "reviewerConversationId",
      reviewerConversationId,
    );
    if (!remediation) {
      await performAutonomyAction(
        flight.id,
        {
          action: "review_remediation",
          subjectId: attempt.id,
          root: rootForAttempt(attempt),
          targetId: targetForAttempt(attempt),
        },
        () => useAsyncFlightStore.getState().sendReviewFindingsToBuilder(flight.id, attempt.id),
        { reviewerConversationId },
      );
      continue;
    }
    const builder = useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === attempt.sessionId);
    if (builder?.status !== "done") continue;
    if (
      completedAction(
        flight,
        "retry_review",
        attempt.id,
        "reviewerConversationId",
        reviewerConversationId,
      )
    ) {
      continue;
    }
    await performAutonomyAction(
      flight.id,
      {
        action: "retry_review",
        subjectId: attempt.id,
        root: rootForAttempt(attempt),
        targetId: targetForAttempt(attempt),
      },
      () => useAsyncFlightStore.getState().retryReviewGate(flight.id, attempt.id),
      { reviewerConversationId },
    );
  }
}

async function syncGraph(flight: Flight): Promise<void> {
  if (!flight.autonomyPolicy?.autoRunTaskGraph || flight.executionMode !== "cooperative") return;
  for (const task of selectReadyCooperativeTasks(flight)) {
    const fresh = currentFlight(flight.id) ?? flight;
    if (activeAgentCount(fresh) >= (fresh.autonomyPolicy?.maxConcurrentAgents ?? 1)) return;
    await performAutonomyAction(
      flight.id,
      {
        action: "launch_ready_task",
        subjectId: task.id,
        root: flight.projectPath,
        targetId:
          flight.integrationBranch?.targetKind === "ssh"
            ? flight.integrationBranch.targetId
            : "local",
        activeAgents: activeAgentCount(fresh),
      },
      () => useAsyncFlightStore.getState().launchReadyTasks(flight.id, [task.id]),
      { taskTitle: task.title },
    );
    if (currentFlight(flight.id)?.autonomyRuntime?.status !== "running") return;
  }
}

function maybeCompleteAutonomy(flight: Flight): void {
  const runtime = flight.autonomyRuntime;
  if (!runtime || runtime.status !== "running") return;
  const tasks = flight.milestones.flatMap((milestone) => milestone.tasks);
  const attempts = flight.attempts ?? [];
  const graphComplete =
    flight.executionMode === "cooperative" &&
    tasks.length > 0 &&
    tasks.every((task) => task.status === "done");
  const attemptsComplete =
    flight.executionMode !== "cooperative" &&
    attempts.length > 0 &&
    attempts.every((attempt) => ["completed", "cancelled"].includes(attempt.status));
  if (!graphComplete && !attemptsComplete) return;
  useFlightStore.getState().updateFlight(flight.id, {
    autonomyRuntime: {
      ...runtime,
      status: "completed",
      hardStopReason: graphComplete
        ? "All task branches are integrated. Final landing into the base branch remains explicit."
        : undefined,
    },
  });
}

async function syncOneFlight(flight: Flight): Promise<void> {
  if (flight.autonomyRuntime?.status !== "running") return;
  const continuation = evaluateAutonomyAction(flight, {
    action: "continue",
    root: flight.projectPath,
    targetId:
      flight.integrationBranch?.targetKind === "ssh" ? flight.integrationBranch.targetId : "local",
  });
  if (!continuation.allowed) {
    if (continuation.hardStop) stopForAttention(flight.id, continuation.reason);
    return;
  }
  await syncToolPosture(currentFlight(flight.id) ?? flight);
  await syncReview(currentFlight(flight.id) ?? flight);
  await syncRecovery(currentFlight(flight.id) ?? flight);
  await syncGraph(currentFlight(flight.id) ?? flight);
  maybeCompleteAutonomy(currentFlight(flight.id) ?? flight);
}

async function drainSync(): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    while (syncRequested) {
      syncRequested = false;
      for (const flight of useFlightStore.getState().flights) {
        await syncOneFlight(flight);
      }
    }
  } finally {
    syncRunning = false;
  }
}

function queueSync(): void {
  syncRequested = true;
  queueMicrotask(() => void drainSync());
}

export function startFlightAutonomy(flightId: string): void {
  const flight = currentFlight(flightId);
  if (!flight?.autonomyPolicy || !flight.autonomyRuntime) {
    throw new Error("Configure a bounded autonomy policy before starting.");
  }
  const errors = validateAutonomyPolicy(flight.autonomyPolicy, flight);
  if (errors.length > 0) throw new Error(errors[0]);
  if (flight.autonomyRuntime.status === "stopped") {
    throw new Error("This autonomy run was stopped. Choose YOLO again to create a new run.");
  }
  useFlightStore.getState().updateFlight(flightId, {
    status: "active",
    autonomyRuntime: {
      ...flight.autonomyRuntime,
      status: "running",
      startedAt: flight.autonomyRuntime.startedAt ?? Date.now(),
      pausedAt: undefined,
      hardStopReason: undefined,
    },
  });
  queueSync();
}

export function pauseFlightAutonomy(flightId: string): void {
  updateRuntime(flightId, (runtime) => ({
    ...runtime,
    status: "paused",
    pausedAt: Date.now(),
    hardStopReason: "Paused by the user.",
  }));
}

export async function stopFlightAutonomy(
  flightId: string,
  cancelRunningAttempts = true,
): Promise<void> {
  const flight = currentFlight(flightId);
  if (!flight?.autonomyRuntime) return;
  useFlightStore.getState().updateFlight(flightId, {
    status: "paused",
    autonomyRuntime: {
      ...flight.autonomyRuntime,
      status: "stopped",
      stoppedAt: Date.now(),
      hardStopReason: "Stopped by the user.",
    },
  });
  if (!cancelRunningAttempts) return;
  for (const attempt of flight.attempts ?? []) {
    if (!["queued", "provisioning", "running"].includes(attempt.status)) continue;
    await useAsyncFlightStore.getState().cancelAttempt(flightId, attempt.id);
  }
}

export function startBoundedAutonomyRuntime(): () => void {
  if (unsubscribeFlight || unsubscribeAgents) {
    return () => undefined;
  }
  // A desktop restart never resumes unattended work. Rust performs the same
  // recovery for persisted state; this frontend guard also covers test/dev
  // hydration paths that do not pass through the native startup recovery.
  for (const flight of useFlightStore.getState().flights) {
    if (flight.autonomyRuntime?.status !== "running") continue;
    useFlightStore.getState().updateFlight(flight.id, {
      status: "paused",
      autonomyRuntime: pauseAutonomyForRestart(flight.autonomyRuntime),
    });
  }
  unsubscribeFlight = useFlightStore.subscribe(queueSync);
  unsubscribeAgents = useAgentTaskStore.subscribe(queueSync);
  queueSync();
  return () => {
    unsubscribeFlight?.();
    unsubscribeAgents?.();
    unsubscribeFlight = null;
    unsubscribeAgents = null;
  };
}
