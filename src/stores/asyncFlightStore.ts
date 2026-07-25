import { create } from "zustand";
import {
  launchFlightAsync,
  cancelFlightAttempt,
  cleanupAttemptWorktreeSsh,
  markAttemptStatus,
  setAttemptDraftPr,
  summarizeFlight,
  type AttemptTargetSpec,
} from "@/lib/tauri";
import {
  buildFlightSummaryInput,
  buildAttemptSessionLogs,
  parseFlightRetrospective,
} from "@/lib/flightRetrospective";
import { publishBranchAsPr } from "@/lib/gitPublish";
import { useFlightStore } from "@/stores/flightStore";
import {
  useAgentTaskStore,
  type AgentCli,
  type CreateApiConversationOptions,
} from "@/stores/agentTaskStore";
import { useServerStore } from "@/stores/serverStore";
import { useGitHubStore } from "@/stores/githubStore";
import { assertCostGuardrailsAllowLaunch } from "@/stores/costGuardrailStore";
import { useMemoryStore } from "@/stores/memoryStore";
import { getMemorySettings } from "@/stores/memorySettingsStore";
import type { FlightCompletedPayload } from "@/types/memory";
import type { Attempt, AttemptStatus, Flight } from "@/types/flight";
import { claimedPathsOverlap, normalizeClaimedPath } from "@/lib/pathCollisions";
import {
  detachAttemptTerminalListeners,
  syncAsyncAttemptTerminalListeners,
} from "@/stores/asyncAttemptTerminalListeners";
import { maybeEscalate, recordAttemptFailure } from "@/lib/flightCoordination";
import { getDefaultModel, getProviderForAgent } from "@/lib/api-models";
import type { ServerConfig } from "@/types/server";

export interface AsyncLaunchOptions {
  allowPathCollisions?: boolean;
}

export type AsyncLaunchPathCollision =
  | {
      kind: "duplicate_target";
      path: string;
      message: string;
    }
  | {
      kind: "active_attempt";
      path: string;
      message: string;
      flightId: string;
      attemptId: string;
    }
  | {
      kind: "task_owned_path";
      path: string;
      message: string;
      flightId: string;
      taskId: string;
      otherTaskId: string;
    };

interface AsyncFlightStore {
  /** Launch N parallel attempts on a Flight. Persists Attempts on the Flight. */
  launchAsync: (
    flightId: string,
    prompt: string,
    targets: AttemptTargetSpec[],
    options?: AsyncLaunchOptions,
  ) => Promise<Attempt[]>;

  /** Cancel a single attempt: closes the API session, removes worktree, marks Cancelled. */
  cancelAttempt: (flightId: string, attemptId: string) => Promise<void>;

  /** Set an attempt's status from the UI (e.g. user clicks Accept/Reject). */
  setAttemptStatus: (
    flightId: string,
    attemptId: string,
    status: Extract<AttemptStatus, "reviewing" | "completed" | "failed" | "cancelled">,
  ) => Promise<void>;

  /**
   * E4: relaunch a failed attempt on a different agent. Rebuilds a launch
   * target from the failed attempt (same repo/branch, the new agent's default
   * model), records a `handoff` coordination event, and appends a fresh attempt
   * via `launchAsync`. The failed record is kept for history.
   */
  reassignAttempt: (
    flightId: string,
    attemptId: string,
    newAgentConfigId: string,
  ) => Promise<void>;
}

/**
 * E4 (pure): build a launch target from a failed attempt, swapping in a new
 * agent + its default model, reusing the attempt's repo base / branch. SSH
 * targets are reconstructed from the saved `ServerConfig` (the Attempt record
 * intentionally doesn't persist connection details); returns `null` when that
 * server is no longer configured.
 */
export function buildReassignSpec(
  failed: Attempt,
  newAgentConfigId: string,
  lookupServer: (id: string) => ServerConfig | undefined,
): AttemptTargetSpec | null {
  const provider = newAgentConfigId.replace(/^api-/, "");
  const model = getDefaultModel(newAgentConfigId as AgentCli);
  if (failed.target.kind === "local") {
    return {
      kind: "local",
      basePath: failed.target.basePath,
      baseBranch: failed.baseBranch,
      agentConfigId: newAgentConfigId,
      provider,
      model,
    };
  }
  const server = lookupServer(failed.target.targetId);
  if (!server) return null;
  return {
    kind: "ssh",
    targetId: server.id,
    host: server.host,
    port: server.port,
    user: server.username,
    keyPath: server.keyPath ?? null,
    authMethod: server.authMethod,
    hostFingerprint: server.hostFingerprint ?? null,
    basePath: failed.target.basePath,
    baseBranch: failed.baseBranch,
    agentConfigId: newAgentConfigId,
    provider,
    model,
  };
}

function applyAttemptsToFlightLocal(flightId: string, attempts: Attempt[], prompt: string) {
  useFlightStore.setState((state) => ({
    flights: state.flights.map((flight) => {
      if (flight.id !== flightId) return flight;
      const attemptsById = new Map((flight.attempts ?? []).map((attempt) => [attempt.id, attempt]));
      for (const attempt of attempts) {
        attemptsById.set(attempt.id, attempt);
      }
      return {
        ...flight,
        attempts: Array.from(attemptsById.values()),
        prompt: flight.prompt ?? prompt,
        updatedAt: Date.now(),
      };
    }),
  }));
}

function patchAttempt(flightId: string, attemptId: string, patch: Partial<Attempt>) {
  const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!flight || !flight.attempts) return;
  const next = flight.attempts.map((a) => (a.id === attemptId ? { ...a, ...patch } : a));
  useFlightStore.getState().updateFlight(flightId, { attempts: next });
}

/**
 * v0.8-G: post-attempt publish pipeline. Called only for attempts on
 * Flights with `publishAttemptsAsPrs == true` that finish in a clean
 * state. Pushes the attempt's worktree branch to `origin`, opens a
 * draft PR with the flight objective as the body, and records the
 * resulting PR number on the attempt.
 *
 * Errors are intentionally swallowed (warn-logged + written into
 * `errorMessage`) so a flaky publish never knocks the attempt itself
 * out of its earned terminal status.
 */
async function publishAttemptAsDraftPr(flight: Flight, attempt: Attempt): Promise<void> {
  // Resolve the GitHub repo target from the user's currently-selected
  // repo. The PRModal already uses this same source-of-truth; for
  // async-Flight publish we follow the same UX contract.
  const selectedRepo = useGitHubStore.getState().config.selectedRepo;
  if (!selectedRepo) {
    console.warn(
      "publishAttemptAsDraftPr: no GitHub repo selected; skipping for attempt",
      attempt.id,
    );
    patchAttempt(flight.id, attempt.id, {
      errorMessage:
        "Draft-PR publish skipped: no GitHub repo selected. Connect a repo in the GitHub pane to enable publishing.",
    });
    return;
  }

  // SSH attempts live on a remote host — `git push` from the local app
  // wouldn't reach the worktree there. Skip cleanly with a clear UI
  // surface (errorMessage is rendered on the AttemptTile) so the user
  // knows why no PR appeared. (Remote publish is v1.1.)
  if (attempt.target.kind !== "local") {
    console.warn(
      "publishAttemptAsDraftPr: SSH attempts are not yet supported; skipping",
      attempt.id,
    );
    patchAttempt(flight.id, attempt.id, {
      errorMessage:
        "Draft-PR publish skipped: SSH attempts are not supported yet. Push the branch and open a PR manually from the remote.",
    });
    return;
  }

  const worktreePath = attempt.target.worktreePath;
  const branchName = attempt.branch;
  const baseBranch = attempt.baseBranch || "main";

  // 1–3. Build the PR body from the flight objective / prompt (capped at the
  //   PR-body size GitHub accepts, ~65 KiB, so we never trip a 422), then push
  //   the branch + open the draft PR through the shared publish path
  //   (`gitPublish.publishBranchAsPr`). Errors are classified by stage and
  //   surfaced onto the attempt with the same copy as before (behavior-
  //   preserving extraction — flights and sessions call the same path now).
  let body = flight.objective || flight.prompt || "";
  body = body.slice(0, 60_000);
  body = `Auto-generated from PacketADE Flight \`${flight.id}\` attempt \`${attempt.id}\`.\n\n${body}`;

  const title = `[Flight ${flight.title}] Attempt ${attempt.id}`.slice(0, 256);

  const result = await publishBranchAsPr({
    worktreePath,
    branch: branchName,
    baseBranch,
    owner: selectedRepo.owner,
    repo: selectedRepo.repo,
    title,
    body,
    draft: true,
  });

  if (!result.ok) {
    if (result.stage === "push") {
      console.warn("publishAttemptAsDraftPr: push failed for", attempt.id, result.message);
      patchAttempt(flight.id, attempt.id, {
        errorMessage: `Draft-PR publish: branch push failed — ${result.message}`,
      });
    } else {
      console.warn("publishAttemptAsDraftPr: create_pr failed for", attempt.id, result.message);
      patchAttempt(flight.id, attempt.id, {
        errorMessage: `Draft-PR publish: GitHub create_pr failed — ${result.message}`,
      });
    }
    return;
  }

  const prNumber = result.prNumber;

  if (prNumber == null) {
    console.warn(
      "publishAttemptAsDraftPr: create_pr succeeded but did not return a PR number",
      attempt.id,
    );
    return;
  }

  // 4. Record the PR number on the attempt + persist.
  //
  // v0.8 race-fix: roll back the optimistic in-memory write if the backend
  // persist fails. Without the rollback, the store would still claim the
  // PR was set; on app restart the publish guard (`!attempt.draftPrNumber`)
  // would re-publish a fresh duplicate PR.
  patchAttempt(flight.id, attempt.id, { draftPrNumber: prNumber });
  try {
    await setAttemptDraftPr(flight.id, attempt.id, prNumber);
  } catch (err) {
    const msg = typeof err === "string" ? err : ((err as Error)?.message ?? "unknown error");
    console.warn("publishAttemptAsDraftPr: failed to persist draft PR number", attempt.id, err);
    patchAttempt(flight.id, attempt.id, {
      draftPrNumber: undefined,
      errorMessage: `Failed to persist draft PR #${prNumber}: ${msg}`,
    });
  }
}

// Module-level map tracking attempts currently mid-publish. Publishing must
// finish before the backend marks an attempt completed because that terminal
// transition removes the local worktree. The map also deduplicates concurrent
// completion clicks before either call records the resulting PR number.
const publishingAttempts = new Map<string, Promise<void>>();
const ACTIVE_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "queued",
  "provisioning",
  "running",
]);

type ClaimRoot = {
  scope: string;
  path: string;
  displayPath: string;
  branch: string;
  caseSensitive: boolean;
};

function targetClaimRoot(target: AttemptTargetSpec): ClaimRoot | null {
  const caseSensitive = target.kind === "ssh";
  const path = normalizeClaimedPath(target.basePath, { caseSensitive });
  if (!path) return null;
  const branch = target.baseBranch.trim().toLowerCase() || "main";
  if (target.kind === "local") {
    return {
      scope: "local",
      path,
      displayPath: target.basePath,
      branch,
      caseSensitive,
    };
  }
  return {
    scope: `ssh:${target.targetId || `${target.user}@${target.host}:${target.port}`}`,
    path,
    displayPath: `${target.targetId || target.host}:${target.basePath}`,
    branch,
    caseSensitive,
  };
}

function attemptClaimRoot(attempt: Attempt): ClaimRoot | null {
  const caseSensitive = attempt.target.kind === "ssh";
  const path = normalizeClaimedPath(attempt.target.basePath, { caseSensitive });
  if (!path) return null;
  const branch = attempt.baseBranch.trim().toLowerCase() || "main";
  if (attempt.target.kind === "local") {
    return {
      scope: "local",
      path,
      displayPath: attempt.target.basePath,
      branch,
      caseSensitive,
    };
  }
  return {
    scope: `ssh:${attempt.target.targetId}`,
    path,
    displayPath: `${attempt.target.targetId}:${attempt.target.basePath}`,
    branch,
    caseSensitive,
  };
}

function claimRootsOverlap(left: ClaimRoot, right: ClaimRoot): boolean {
  return (
    left.scope === right.scope &&
    left.branch === right.branch &&
    claimedPathsOverlap(left.path, right.path, {
      caseSensitive: left.caseSensitive || right.caseSensitive,
    })
  );
}

function getFlightTasks(flight: Flight) {
  return flight.milestones.flatMap((milestone) => milestone.tasks);
}

export function findAsyncLaunchPathCollisions(
  flightId: string | null,
  targets: AttemptTargetSpec[],
  flights = useFlightStore.getState().flights,
): AsyncLaunchPathCollision[] {
  const collisions: AsyncLaunchPathCollision[] = [];
  const targetRoots = targets
    .map((target, index) => ({ index, root: targetClaimRoot(target) }))
    .filter((entry): entry is { index: number; root: ClaimRoot } => Boolean(entry.root));

  for (let i = 0; i < targetRoots.length; i += 1) {
    for (let j = i + 1; j < targetRoots.length; j += 1) {
      const left = targetRoots[i];
      const right = targetRoots[j];
      if (!claimRootsOverlap(left.root, right.root)) continue;
      collisions.push({
        kind: "duplicate_target",
        path: left.root.displayPath,
        message: `Selected targets ${left.index + 1} and ${right.index + 1} both claim ${left.root.displayPath} on ${left.root.branch}.`,
      });
    }
  }

  for (const flight of flights) {
    for (const attempt of flight.attempts ?? []) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      const existingRoot = attemptClaimRoot(attempt);
      if (!existingRoot) continue;
      for (const { root } of targetRoots) {
        if (!claimRootsOverlap(root, existingRoot)) continue;
        collisions.push({
          kind: "active_attempt",
          path: root.displayPath,
          flightId: flight.id,
          attemptId: attempt.id,
          message: `Attempt ${attempt.id} is already ${attempt.status} on ${existingRoot.displayPath} (${existingRoot.branch}).`,
        });
      }
    }
  }

  if (flightId) {
    const flight = flights.find((entry) => entry.id === flightId);
    const activeTasks = flight
      ? getFlightTasks(flight).filter(
          (task) =>
            (task.status === "queued" || task.status === "running") &&
            (task.ownedPaths?.length ?? 0) > 0,
        )
      : [];
    for (let i = 0; i < activeTasks.length; i += 1) {
      for (let j = i + 1; j < activeTasks.length; j += 1) {
        const left = activeTasks[i];
        const right = activeTasks[j];
        for (const leftPath of left.ownedPaths ?? []) {
          const rightPath = (right.ownedPaths ?? []).find((path) =>
            claimedPathsOverlap(leftPath, path),
          );
          if (!rightPath) continue;
          collisions.push({
            kind: "task_owned_path",
            path: leftPath,
            flightId,
            taskId: left.id,
            otherTaskId: right.id,
            message: `Task "${left.title}" and "${right.title}" both claim ${leftPath} / ${rightPath}.`,
          });
        }
      }
    }
  }

  return collisions;
}

export function formatAsyncLaunchPathCollisionMessage(
  collisions: AsyncLaunchPathCollision[],
): string {
  const preview = collisions
    .slice(0, 5)
    .map((collision) => `- ${collision.message}`)
    .join("\n");
  const more = collisions.length > 5 ? `\n- ${collisions.length - 5} more conflict(s)` : "";
  return [
    "Async Flight launch blocked because active executor work already claims the same path.",
    preview + more,
    "Cancel, complete, or block/serialize the conflicting work before launching.",
  ].join("\n");
}

export function assertAsyncLaunchPathGate(
  flightId: string | null,
  targets: AttemptTargetSpec[],
  options: AsyncLaunchOptions = {},
): void {
  if (options.allowPathCollisions) return;
  const collisions = findAsyncLaunchPathCollisions(flightId, targets);
  if (collisions.length > 0) {
    throw new Error(formatAsyncLaunchPathCollisionMessage(collisions));
  }
}

function composeAsyncLaunchPrompt(
  prompt: string,
  flight: Flight | undefined,
  targets: AttemptTargetSpec[],
): string {
  // Flight-prompt injection is opt-out via memory settings. When disabled,
  // launches carry the raw user prompt with no ambient project memory.
  if (!getMemorySettings().injectIntoFlightPrompts) return prompt;
  if (targets.length === 0 || targets.some((target) => target.kind !== "local")) {
    return prompt;
  }

  const candidatePaths = [flight?.projectPath, ...targets.map((target) => target.basePath)].filter(
    (path): path is string => Boolean(path?.trim()),
  );
  const normalized = new Set(candidatePaths.map((path) => path.replace(/\\/g, "/").toLowerCase()));
  if (normalized.size !== 1) return prompt;

  const [projectPath] = candidatePaths;
  const brief = useMemoryStore
    .getState()
    .composeMemoryBrief({ kind: "local", projectPath }, { query: prompt });
  if (!brief.text.trim()) return prompt;
  // M5: remember which learned patterns rode along in this brief so their
  // confidence can be rerated when the flight settles.
  if (flight) {
    const patternIds = brief.items.filter((i) => i.kind === "pattern").map((i) => i.id);
    useMemoryStore.getState().recordInjectedPatterns(flight.id, patternIds);
  }
  return `${brief.text}\n\n---\n\n${prompt}`;
}

async function attachAttemptConversation(attempt: Attempt, prompt: string): Promise<void> {
  let sshTarget: CreateApiConversationOptions["sshTarget"] = null;
  if (attempt.target.kind === "ssh") {
    const server = useServerStore.getState().getServer(attempt.target.targetId);
    if (server) {
      sshTarget = {
        serverId: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        user: server.username,
        remotePath: attempt.target.basePath,
        keyPath: server.keyPath ?? null,
        authMethod: server.authMethod,
        hostFingerprint: server.hostFingerprint ?? null,
      };
    }
  }

  await useAgentTaskStore.getState().createApiConversation({
    agent: attempt.agentConfigId as AgentCli,
    projectPath: attempt.target.worktreePath,
    model: attempt.model,
    initialMessage: prompt,
    systemPromptOverride: null,
    thinkingEnabled: false,
    planMode: false,
    sshTarget,
    explicitId: attempt.sessionId,
    skipBackendStart: true,
  });
}

/**
 * Wave-M2: derive a `flight_completed` memory event from the terminal
 * state of an async Flight's attempts. Called once, at the moment the
 * Flight transitions into its terminal `done` state (all attempts
 * settled, at least one completed). The payload is assembled from the
 * data available on the Flight + its Attempts — there is no separate LLM
 * retrospective — so `lessonsLearned` is derived from failing attempts'
 * error messages rather than model-authored insight.
 */
function buildFlightCompletedPayload(flight: Flight): FlightCompletedPayload {
  const attempts = flight.attempts ?? [];
  const completed = attempts.filter((a) => a.status === "completed");
  const failed = attempts.filter((a) => a.status === "failed");
  const cancelled = attempts.filter((a) => a.status === "cancelled");

  const describe = (a: Attempt) => `Attempt on \`${a.branch}\` (${a.model})`;

  const whatWorked = completed.map(describe);
  const whatFailed = failed.map(
    (a) => `${describe(a)}${a.errorMessage ? `: ${a.errorMessage}` : ""}`,
  );
  const lessonsLearned = failed
    .filter((a) => Boolean(a.errorMessage))
    .map((a) => `On \`${a.branch}\`, avoid what caused: ${a.errorMessage}`);

  const parts = [`${completed.length}/${attempts.length} attempt(s) completed`];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (cancelled.length) parts.push(`${cancelled.length} cancelled`);
  const summary =
    `Flight "${flight.title}" finished: ${parts.join(", ")}.` +
    (flight.objective ? ` Objective: ${flight.objective}` : "");

  return {
    flightId: flight.id,
    flightTitle: flight.title,
    summary,
    whatWorked,
    whatFailed,
    lessonsLearned,
    suggestedImprovements: [],
    tags: ["flight"],
  };
}

/**
 * Fire `captureFlightCompleted` exactly on the non-`done` → `done`
 * transition. `statusBefore` is sampled before the attempt patch; the
 * current status is recomputed here from the freshly-patched flight.
 * Guarding on the transition (rather than the raw target status) means a
 * flight that reaches `done` via any last-attempt outcome — completed,
 * cancelled, or a mixed terminal set — captures once and never re-fires
 * on subsequent no-op status writes. `captureFlightCompleted` itself
 * respects the `captureFlights` setting.
 */
function captureFlightCompletionOnTransition(flightId: string, statusBefore: string): void {
  if (statusBefore === "done") return;
  const flightStore = useFlightStore.getState();
  if (flightStore.computeFlightStatus(flightId) !== "done") return;
  const flight = flightStore.flights.find((f) => f.id === flightId);
  if (!flight) return;
  const memory = useMemoryStore.getState();
  memory.captureFlightCompleted(buildFlightCompletedPayload(flight), flight.projectPath);
  // M5: rerate the patterns injected into this flight's launch brief — a
  // completed attempt is a success signal, an all-failed/cancelled flight a
  // decay signal.
  const success = (flight.attempts ?? []).some((a) => a.status === "completed");
  memory.adjustConfidenceForFlight(flightId, success);
  // M9: opt-in LLM retrospective enrichment (fire-and-forget). Runs after the
  // mechanical capture so a missing/unauthed CLI just leaves the derived
  // payload in place.
  void enrichFlightRetrospective(flight);
}

/**
 * M9: replace the mechanically-derived `lessonsLearned` (and sibling fields)
 * with a model-authored retrospective when learning is enabled. Best-effort:
 * any failure (CLI absent, non-JSON output, non-local project) is swallowed and
 * the already-captured mechanical payload stands.
 */
async function enrichFlightRetrospective(flight: Flight): Promise<void> {
  const settings = getMemorySettings();
  if (!settings.captureFlights || !settings.summarizeSessions) return;
  if (!flight.projectPath?.trim()) return;
  // Remote/SSH attempts don't have a validatable local project_path for the
  // Rust command; only enrich all-local flights.
  const attempts = flight.attempts ?? [];
  if (attempts.some((a) => a.target.kind !== "local")) return;
  try {
    const raw = await summarizeFlight(
      flight.projectPath,
      buildFlightSummaryInput(flight),
      buildAttemptSessionLogs(flight),
    );
    const retro = parseFlightRetrospective(raw);
    if (retro) useMemoryStore.getState().updateFlightRetrospective(flight.id, retro);
  } catch (err) {
    console.warn("flight retrospective enrichment failed", err);
  }
}

async function cleanupSshAttemptWorktree(flightId: string, attempt: Attempt): Promise<void> {
  if (attempt.target.kind !== "ssh") return;
  const server = useServerStore.getState().getServer(attempt.target.targetId);
  if (!server) {
    console.warn(
      "SSH worktree cleanup skipped because the saved server no longer exists:",
      attempt.target.targetId,
    );
    return;
  }

  try {
    await cleanupAttemptWorktreeSsh({
      flightId,
      attemptId: attempt.id,
      host: server.host,
      port: server.port,
      user: server.username,
      keyPath: server.keyPath ?? null,
      basePath: attempt.target.basePath,
      targetId: server.id,
      hostFingerprint: server.hostFingerprint ?? null,
    });
  } catch (err) {
    console.warn("SSH worktree cleanup failed:", err);
  }
}

export const useAsyncFlightStore = create<AsyncFlightStore>(() => ({
  launchAsync: async (flightId, prompt, targets, options = {}) => {
    assertAsyncLaunchPathGate(flightId, targets, options);
    for (const target of targets) {
      await assertCostGuardrailsAllowLaunch(target.provider, flightId);
    }
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const promptForLaunch = composeAsyncLaunchPrompt(prompt, flight, targets);
    const attemptIdsBefore = new Set((flight?.attempts ?? []).map((attempt) => attempt.id));
    let attempts: Attempt[];
    try {
      attempts = await launchFlightAsync(flightId, promptForLaunch, targets, {
        allowPathCollisions: options.allowPathCollisions,
      });
    } catch (error) {
      // Multi-target provisioning is sequential. If a later target fails,
      // earlier attempts may already be persisted and running even though the
      // command rejects. Rehydrate and attach those partial successes so they
      // remain visible/controllable, then preserve the original launch error.
      await useFlightStore.getState().hydrateFromBackend();
      const partialAttempts =
        useFlightStore
          .getState()
          .flights.find((current) => current.id === flightId)
          ?.attempts?.filter((attempt) => !attemptIdsBefore.has(attempt.id)) ?? [];
      for (const attempt of partialAttempts) {
        try {
          await attachAttemptConversation(attempt, promptForLaunch);
        } catch (attachError) {
          console.warn(
            "Failed to attach partial Flight attempt listeners:",
            attempt.id,
            attachError,
          );
        }
      }
      throw error;
    }

    const flightsWithAttempts = useFlightStore.getState().flights.map((currentFlight) => {
      if (currentFlight.id !== flightId) return currentFlight;
      return {
        ...currentFlight,
        attempts: [...(currentFlight.attempts ?? []), ...attempts],
        prompt: currentFlight.prompt ?? promptForLaunch,
        updatedAt: Date.now(),
      };
    });

    // Register terminal listeners before mutating local state so a very fast
    // `api-agent:done/error` event cannot land between backend start and the
    // listener install. The backend already persisted the attempts, so this
    // local projection deliberately avoids saving and clobbering a fresher
    // backend terminal status.
    await syncAsyncAttemptTerminalListeners(flightsWithAttempts);
    await useFlightStore
      .getState()
      .hydrateFromBackend()
      .catch((err) => console.warn("Failed to hydrate async launch attempts:", err));
    const latestFlight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const latestAttempts = attempts.map(
      (attempt) => latestFlight?.attempts?.find((current) => current.id === attempt.id) ?? attempt,
    );
    applyAttemptsToFlightLocal(flightId, latestAttempts, promptForLaunch);

    // For each attempt, register a frontend AgentConversation that listens to
    // the same backend event channel (apiAgent*Event(sessionId)) so AttemptTile
    // can render the live stream. The backend has already started the session;
    // we pass `skipBackendStart=true`.
    for (const a of attempts) {
      try {
        await attachAttemptConversation(a, promptForLaunch);
      } catch (err) {
        console.warn("Failed to attach attempt listeners:", a.id, err);
      }
    }

    return attempts;
  },

  cancelAttempt: async (flightId, attemptId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attempt = flight?.attempts?.find((a) => a.id === attemptId);

    // Sample the flight's rolled-up status BEFORE the patch — same
    // non-`done` → `done` transition guard as `setAttemptStatus` (see
    // captureFlightCompletionOnTransition). Cancelling the last outstanding
    // attempt while a sibling has already completed is a real terminal
    // "done" transition and must capture too.
    const statusBefore = useFlightStore.getState().computeFlightStatus(flightId);

    await cancelFlightAttempt(flightId, attemptId);
    patchAttempt(flightId, attemptId, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    if (attempt) {
      detachAttemptTerminalListeners(attempt.sessionId);
    }

    captureFlightCompletionOnTransition(flightId, statusBefore);

    // N2: cancelling the last non-terminal attempt can leave the flight stuck
    // (a sibling already failed) — evaluate an escalation *suggestion*. A cancel
    // is not itself a failure, so no `task_failed` event is recorded here.
    maybeEscalate(flightId);

    // SSH cleanup needs connection details that the backend Attempt record
    // intentionally does not persist, so finish it from the saved Server.
    if (attempt) await cleanupSshAttemptWorktree(flightId, attempt);
  },

  setAttemptStatus: async (flightId, attemptId, status) => {
    // Sample the flight's rolled-up status BEFORE the patch so we can detect
    // the non-`done` → `done` transition and capture a flight_completed
    // memory event exactly once (see captureFlightCompletionOnTransition).
    const statusBefore = useFlightStore.getState().computeFlightStatus(flightId);

    const flightBefore = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attemptBefore = flightBefore?.attempts?.find((a) => a.id === attemptId);

    // Publish while the local worktree still exists. `markAttemptStatus(...,
    // "completed")` removes it, so the old fire-and-forget ordering made every
    // enabled local draft-PR publish fail at `git push` with a missing cwd.
    if (
      status === "completed" &&
      flightBefore?.publishAttemptsAsPrs &&
      attemptBefore &&
      !attemptBefore.draftPrNumber
    ) {
      let publish = publishingAttempts.get(attemptBefore.id);
      if (!publish) {
        publish = publishAttemptAsDraftPr(flightBefore, attemptBefore).finally(() => {
          publishingAttempts.delete(attemptBefore.id);
        });
        publishingAttempts.set(attemptBefore.id, publish);
      }
      await publish;
    }

    await markAttemptStatus(flightId, attemptId, status);
    patchAttempt(flightId, attemptId, {
      status,
      ...(status === "completed" || status === "failed" || status === "cancelled"
        ? { completedAt: Date.now() }
        : {}),
    });
    if (status === "completed" || status === "failed" || status === "cancelled") {
      const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
      const attempt = flight?.attempts?.find((a) => a.id === attemptId);
      if (attempt) detachAttemptTerminalListeners(attempt.sessionId);
      if (attemptBefore) await cleanupSshAttemptWorktree(flightId, attemptBefore);
    }

    // N2: a rejected/failed attempt records a coordination event and, when the
    // flight is now stuck, an escalation *suggestion* (never an auto-action).
    if (status === "failed") {
      const attempt = useFlightStore
        .getState()
        .flights.find((f) => f.id === flightId)
        ?.attempts?.find((a) => a.id === attemptId);
      recordAttemptFailure(flightId, attemptId, attempt?.errorMessage);
    } else if (status === "cancelled") {
      // A cancel isn't a failure, so no `task_failed` — but it may complete a
      // stuck state if a sibling already failed. Suggest, don't act.
      maybeEscalate(flightId);
    }

    // Flight-completion memory capture. Runs on the terminal-success
    // transition regardless of which attempt outcome triggered it.
    captureFlightCompletionOnTransition(flightId, statusBefore);
  },

  reassignAttempt: async (flightId, attemptId, newAgentConfigId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const failed = flight?.attempts?.find((a) => a.id === attemptId);
    if (!flight || !failed) return;

    const spec = buildReassignSpec(failed, newAgentConfigId, (id) =>
      useServerStore.getState().getServer(id),
    );
    if (!spec) {
      console.warn(
        `reassignAttempt: cannot rebuild target for attempt '${attemptId}' — SSH server no longer configured`,
      );
      return;
    }

    const toLabel = getProviderForAgent(newAgentConfigId as AgentCli)?.name ?? newAgentConfigId;
    useFlightStore.getState().appendCoordinationEvent(flightId, {
      type: "handoff",
      taskId: attemptId,
      agentId: newAgentConfigId,
      summary: `Reassigned to ${toLabel} after the ${failed.provider} attempt failed.`,
      metadata: { reassignedFromAttemptId: attemptId, toAgentId: newAgentConfigId },
    });

    // Reuse the normal launch path — it provisions a fresh worktree and appends
    // a new attempt to this flight, leaving the failed record in place.
    const prompt = flight.prompt ?? flight.objective ?? "";
    await useAsyncFlightStore.getState().launchAsync(flightId, prompt, [spec]);
  },
}));
