import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { apiAgentDoneEvent, apiAgentErrorEvent } from "@/lib/events";
import {
  buildReviewEvidenceBundle,
  buildReviewerInitialMessage,
  buildReviewerRemediationPrompt,
  buildReviewerSystemPrompt,
  parseLatestReviewGateReport,
  REVIEWER_ALLOWED_TOOLS,
} from "@/lib/reviewerGate";
import { getDefaultModel } from "@/lib/api-models";
import { setAttemptReviewGate } from "@/lib/tauri";
import { derivedArtifactProvenance } from "@/lib/provenance";
import { requestConversationSave } from "@/stores/agentConversationPersistence";
import { resolveRetiredApiAgent, useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useFlightStore } from "@/stores/flightStore";
import { useServerStore } from "@/stores/serverStore";
import type { Attempt, AttemptReviewGate, Flight, ReviewGateReport } from "@/types/flight";

const startingAttempts = new Set<string>();
const reviewerCleanups = new Map<string, UnlistenFn[]>();
let syncQueued = false;

function attemptKey(flightId: string, attemptId: string): string {
  return `${flightId}:${attemptId}`;
}

function currentFlight(flightId: string): Flight | undefined {
  return useFlightStore.getState().flights.find((flight) => flight.id === flightId);
}

function currentAttempt(flightId: string, attemptId: string): Attempt | undefined {
  return currentFlight(flightId)?.attempts?.find((attempt) => attempt.id === attemptId);
}

/**
 * Write the gate to the store for immediate UI, and to the backend for
 * persistence.
 *
 * The backend write is not optional. `reviewGate` is an attempt lifecycle
 * field, and the Rust snapshot merge keeps its own copy of an existing
 * attempt — so a gate that only ever reached `flightStore` was dropped on the
 * next flight save, and `markAttemptStatus("completed")` then rejected every
 * gated acceptance with "Reviewer Gate has not produced a verdict".
 */
async function patchReviewGate(
  flightId: string,
  attemptId: string,
  gate: AttemptReviewGate,
): Promise<void> {
  const flight = currentFlight(flightId);
  if (!flight?.attempts) return;
  useFlightStore.getState().updateFlight(flightId, {
    attempts: flight.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, reviewGate: gate } : attempt,
    ),
  });
  try {
    await setAttemptReviewGate(flightId, attemptId, gate);
  } catch (error) {
    // Non-fatal for the UI, but it means acceptance will stay blocked, so it
    // must be visible rather than swallowed.
    console.error(`Failed to persist the Reviewer Gate verdict for attempt ${attemptId}:`, error);
  }
}

function detachReviewerListeners(conversationId: string): void {
  const cleanups = reviewerCleanups.get(conversationId);
  if (!cleanups) return;
  reviewerCleanups.delete(conversationId);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Best-effort listener cleanup.
    }
  }
}

function reportStatus(report: ReviewGateReport): AttemptReviewGate["status"] {
  if (report.verdict === "pass") return "passed";
  if (report.verdict === "blocked") return "blocked";
  return "changes_requested";
}

function finishReviewer(flightId: string, attemptId: string, conversationId: string): void {
  const attempt = currentAttempt(flightId, attemptId);
  if (!attempt || attempt.reviewGate?.reviewerConversationId !== conversationId) return;
  const conversation = useAgentTaskStore
    .getState()
    .conversations.find((item) => item.id === conversationId);
  try {
    const parsedReport = parseLatestReviewGateReport(conversation?.messages ?? []);
    const reviewerSource = [...(conversation?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant")?.provenance;
    const report: ReviewGateReport = {
      ...parsedReport,
      provenance: derivedArtifactProvenance(
        `${attemptId}-review-report`,
        "Independent reviewer report",
        reviewerSource ? [reviewerSource] : [],
      ),
    };
    const status = reportStatus(report);
    void patchReviewGate(flightId, attemptId, {
      ...attempt.reviewGate,
      status,
      report,
      errorMessage: undefined,
      completedAt: Date.now(),
    });
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_resolved",
      taskId: attemptId,
      agentId: attempt.reviewGate.reviewerAgentConfigId,
      summary:
        status === "passed"
          ? "Independent Reviewer Gate passed."
          : `Independent Reviewer Gate returned ${report.verdict.replace(/_/g, " ")}: ${report.summary}`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        verdict: report.verdict,
      },
      provenance: report.provenance,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void patchReviewGate(flightId, attemptId, {
      ...attempt.reviewGate,
      status: "error",
      errorMessage: message,
      completedAt: Date.now(),
    });
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_resolved",
      taskId: attemptId,
      agentId: attempt.reviewGate.reviewerAgentConfigId,
      summary: `Independent Reviewer Gate could not produce a valid verdict: ${message}`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        verdict: "error",
      },
    });
  } finally {
    detachReviewerListeners(conversationId);
  }
}

async function installReviewerListeners(
  flightId: string,
  attemptId: string,
  conversationId: string,
): Promise<void> {
  if (reviewerCleanups.has(conversationId)) return;
  const cleanups: UnlistenFn[] = [];
  reviewerCleanups.set(conversationId, cleanups);

  const done = await listen(apiAgentDoneEvent(conversationId), () => {
    // Let the normal conversation listener flush the final streamed chunk.
    setTimeout(() => finishReviewer(flightId, attemptId, conversationId), 0);
  });
  if (reviewerCleanups.has(conversationId)) cleanups.push(done);
  else done();

  const failed = await listen<{ message?: string }>(apiAgentErrorEvent(conversationId), (event) => {
    const attempt = currentAttempt(flightId, attemptId);
    if (!attempt || attempt.reviewGate?.reviewerConversationId !== conversationId) return;
    const message = event.payload?.message?.trim() || "The reviewer session failed.";
    void patchReviewGate(flightId, attemptId, {
      ...attempt.reviewGate,
      status: "error",
      errorMessage: message,
      completedAt: Date.now(),
    });
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_resolved",
      taskId: attemptId,
      agentId: attempt.reviewGate.reviewerAgentConfigId,
      summary: `Independent Reviewer Gate failed: ${message}`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        verdict: "error",
      },
    });
    detachReviewerListeners(conversationId);
  });
  if (reviewerCleanups.has(conversationId)) cleanups.push(failed);
  else failed();
}

export async function startReviewGate(
  flightId: string,
  attemptId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const key = attemptKey(flightId, attemptId);
  if (startingAttempts.has(key)) return;

  const flight = currentFlight(flightId);
  const attempt = currentAttempt(flightId, attemptId);
  const policy = flight?.reviewGatePolicy;
  if (!flight || !attempt || attempt.status !== "reviewing" || !policy?.enabled) return;
  if (!options.force && attempt.reviewGate) return;

  startingAttempts.add(key);
  // A persisted policy can name a provider that no longer exists — chiefly
  // `api-openai-codex`, removed in 2026-07. Substituting its designated
  // replacement is the one place a retired id SHOULD be remapped: a reviewer
  // gate that silently no-ops is strictly worse than one that reviews with a
  // comparable model, and the alternative (an unroutable provider) fails the
  // attempt for a reason the user cannot act on. Conversations get the
  // opposite treatment — read-only, explicit user switch, never automatic.
  const reviewerAgent = resolveRetiredApiAgent(policy.reviewerAgentConfigId as AgentCli);
  // Also re-derive the model when the agent was substituted: a `gpt-5.5`
  // pinned for Codex is not necessarily a model the replacement offers, and
  // `getDefaultModel` on a retired id returns "" (an empty model string is
  // how this used to reach the backend).
  const substituted = reviewerAgent !== policy.reviewerAgentConfigId;
  const reviewerModel = (substituted ? "" : policy.reviewerModel) || getDefaultModel(reviewerAgent);
  const conversationId = `review-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  await patchReviewGate(flightId, attemptId, {
    status: "running",
    reviewerConversationId: conversationId,
    reviewerAgentConfigId: reviewerAgent,
    reviewerModel,
    startedAt,
  });

  try {
    const builderConversation = useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === attempt.sessionId);
    const evidence = await buildReviewEvidenceBundle(flight, attempt, {
      builderConversation,
      lookupServer: (id) => useServerStore.getState().getServer(id),
    });
    await installReviewerListeners(flightId, attemptId, conversationId);

    const server =
      attempt.target.kind === "ssh"
        ? useServerStore.getState().getServer(attempt.target.serverId)
        : undefined;
    if (attempt.target.kind === "ssh" && !server) {
      throw new Error("The SSH server used by this attempt is no longer configured.");
    }
    const sshTarget = server
      ? {
          serverId: server.id,
          name: server.name,
          host: server.host,
          port: server.port,
          user: server.username,
          remotePath: attempt.target.worktreePath,
          keyPath: server.keyPath ?? null,
          authMethod: server.authMethod,
          hostFingerprint: server.hostFingerprint ?? null,
        }
      : null;

    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "review_requested",
      taskId: attemptId,
      agentId: reviewerAgent,
      summary: `Started an independent read-only review with ${reviewerAgent}.`,
      metadata: {
        attemptId,
        reviewerConversationId: conversationId,
        reviewerModel,
      },
    });

    await useAgentTaskStore.getState().createApiConversation({
      explicitId: conversationId,
      agent: reviewerAgent,
      projectPath: attempt.target.worktreePath,
      model: reviewerModel,
      initialMessage: buildReviewerInitialMessage(evidence),
      systemPromptOverride: buildReviewerSystemPrompt(),
      planMode: true,
      sshTarget,
      allowedTools: REVIEWER_ALLOWED_TOOLS,
      enabledMcpServerIds: [],
      memoryContextEnabled: false,
      permissionMode: "deny_all",
      approveWrites: false,
    });
    useAgentTaskStore.setState((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, title: `Review — ${flight.title}` }
          : conversation,
      ),
    }));
    requestConversationSave(conversationId);
    useFlightStore.getState().updateFlight(flightId, {
      linkedSessionIds: Array.from(new Set([...flight.linkedSessionIds, conversationId])),
    });

    const created = useAgentTaskStore
      .getState()
      .conversations.find((conversation) => conversation.id === conversationId);
    if (created?.status === "failed") {
      throw new Error("The reviewer session could not be started.");
    }
    if (created?.status === "done") finishReviewer(flightId, attemptId, conversationId);
  } catch (error) {
    detachReviewerListeners(conversationId);
    const message = error instanceof Error ? error.message : String(error);
    const fresh = currentAttempt(flightId, attemptId);
    if (fresh?.reviewGate?.reviewerConversationId === conversationId) {
      await patchReviewGate(flightId, attemptId, {
        ...fresh.reviewGate,
        status: "error",
        errorMessage: message,
        completedAt: Date.now(),
      });
      useFlightStore.getState().appendCoordinationEvent(flightId, {
        type: "review_resolved",
        taskId: attemptId,
        agentId: reviewerAgent,
        summary: `Independent Reviewer Gate failed to start: ${message}`,
        metadata: { attemptId, reviewerConversationId: conversationId, verdict: "error" },
      });
    }
  } finally {
    startingAttempts.delete(key);
  }
}

export async function retryReviewGate(flightId: string, attemptId: string): Promise<void> {
  const attempt = currentAttempt(flightId, attemptId);
  if (!attempt?.reviewGate) return;
  await patchReviewGate(flightId, attemptId, {
    status: "pending",
    reviewerAgentConfigId: attempt.reviewGate.reviewerAgentConfigId,
    reviewerModel: attempt.reviewGate.reviewerModel,
  });
  await startReviewGate(flightId, attemptId, { force: true });
}

export async function overrideReviewGate(
  flightId: string,
  attemptId: string,
  reason: string,
): Promise<void> {
  const normalized = reason.trim();
  if (normalized.length < 3) throw new Error("An override reason is required.");
  if (normalized.length > 2_000) throw new Error("The override reason is too long.");
  const attempt = currentAttempt(flightId, attemptId);
  if (!attempt?.reviewGate || attempt.reviewGate.status === "passed") return;
  await patchReviewGate(flightId, attemptId, {
    ...attempt.reviewGate,
    status: "overridden",
    overriddenAt: Date.now(),
    overrideReason: normalized,
  });
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "review_resolved",
    taskId: attemptId,
    agentId: "user",
    summary: `Reviewer Gate overridden by the user: ${normalized}`,
    metadata: {
      attemptId,
      verdict: "overridden",
      overrideReason: normalized,
    },
  });
  await useFlightStore.getState().flushPersistence();
}

export async function sendReviewFindingsToBuilder(
  flightId: string,
  attemptId: string,
): Promise<void> {
  const attempt = currentAttempt(flightId, attemptId);
  const report = attempt?.reviewGate?.report;
  if (!attempt || !report) throw new Error("No structured reviewer findings are available.");
  const reviewerConversationId = attempt.reviewGate?.reviewerConversationId ?? "";
  const builder = useAgentTaskStore
    .getState()
    .conversations.find((conversation) => conversation.id === attempt.sessionId);
  if (!builder) throw new Error("The builder conversation is no longer available.");
  useAgentTaskStore
    .getState()
    .sendMessage(attempt.sessionId, buildReviewerRemediationPrompt(report));
  useFlightStore.getState().appendCoordinationEvent(flightId, {
    type: "handoff",
    taskId: attemptId,
    agentId: attempt.agentConfigId,
    summary: "Sent the independent reviewer findings to the builder for one remediation turn.",
    metadata: {
      attemptId,
      reviewerConversationId,
      verdict: report.verdict,
    },
  });
}

export async function syncReviewerGateRuns(
  flights = useFlightStore.getState().flights,
): Promise<void> {
  for (const flight of flights) {
    if (!flight.reviewGatePolicy?.enabled) continue;
    for (const attempt of flight.attempts ?? []) {
      if (attempt.status !== "reviewing") continue;
      const gate = attempt.reviewGate;
      if (!gate) {
        void startReviewGate(flight.id, attempt.id);
        continue;
      }
      if (gate.status !== "running" || !gate.reviewerConversationId) continue;
      const conversation = useAgentTaskStore
        .getState()
        .conversations.find((item) => item.id === gate.reviewerConversationId);
      if (conversation?.status === "done") {
        finishReviewer(flight.id, attempt.id, gate.reviewerConversationId);
      } else if (conversation?.status === "failed") {
        await patchReviewGate(flight.id, attempt.id, {
          ...gate,
          status: "error",
          errorMessage: "The reviewer session failed or was interrupted. Retry the reviewer.",
          completedAt: Date.now(),
        });
      } else if (conversation) {
        await installReviewerListeners(flight.id, attempt.id, gate.reviewerConversationId);
      }
    }
  }
}

function queueSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    void syncReviewerGateRuns();
  });
}

if (typeof useFlightStore.subscribe === "function") useFlightStore.subscribe(queueSync);
if (typeof useAgentTaskStore.subscribe === "function") useAgentTaskStore.subscribe(queueSync);
queueSync();
