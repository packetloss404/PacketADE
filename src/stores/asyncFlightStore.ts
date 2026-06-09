import { create } from "zustand";
import {
  launchFlightAsync,
  cancelFlightAttempt,
  cleanupAttemptWorktreeSsh,
  markAttemptStatus,
  gitPushBranch,
  githubCreatePr,
  setAttemptDraftPr,
  type AttemptTargetSpec,
} from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useServerStore } from "@/stores/serverStore";
import { useGitHubStore } from "@/stores/githubStore";
import { assertCostGuardrailsAllowLaunch } from "@/stores/costGuardrailStore";
import { useMemoryStore } from "@/stores/memoryStore";
import type { Attempt, AttemptStatus, Flight } from "@/types/flight";
import { claimedPathsOverlap, normalizeClaimedPath } from "@/lib/pathCollisions";
import {
  detachAttemptTerminalListeners,
  syncAsyncAttemptTerminalListeners,
} from "@/stores/asyncAttemptTerminalListeners";

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

  // 1. Push the attempt branch to origin (sets upstream on first push).
  try {
    await gitPushBranch(worktreePath, branchName, false);
  } catch (err) {
    const msg = typeof err === "string" ? err : ((err as Error)?.message ?? "push failed");
    console.warn("publishAttemptAsDraftPr: push failed for", attempt.id, msg);
    patchAttempt(flight.id, attempt.id, {
      errorMessage: `Draft-PR publish: branch push failed — ${msg}`,
    });
    return;
  }

  // 2. Build the PR body from the flight objective / prompt. Cap at the
  //    PR-body size GitHub accepts (~65 KiB) so we never trip a 422.
  let body = flight.objective || flight.prompt || "";
  body = body.slice(0, 60_000);
  body = `Auto-generated from PacketADE Flight \`${flight.id}\` attempt \`${attempt.id}\`.\n\n${body}`;

  const title = `[Flight ${flight.title}] Attempt ${attempt.id}`.slice(0, 256);

  // 3. Open the draft PR.
  let prNumber: number | null = null;
  try {
    const json = await githubCreatePr(
      selectedRepo.owner,
      selectedRepo.repo,
      title,
      body,
      branchName,
      baseBranch,
      true, // draft
    );
    const pr = JSON.parse(json) as { number?: number };
    if (typeof pr.number === "number") prNumber = pr.number;
  } catch (err) {
    const msg = typeof err === "string" ? err : ((err as Error)?.message ?? "create_pr failed");
    console.warn("publishAttemptAsDraftPr: create_pr failed for", attempt.id, msg);
    patchAttempt(flight.id, attempt.id, {
      errorMessage: `Draft-PR publish: GitHub create_pr failed — ${msg}`,
    });
    return;
  }

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

// v0.8 race-fix: module-level set tracking attempts currently mid-publish.
// `publishAttemptAsDraftPr` is fire-and-forget from `setAttemptStatus`, and
// its `patchAttempt({ draftPrNumber })` write doesn't land until step 4 of
// the publish flow. Two concurrent `setAttemptStatus(..., "completed")`
// calls would both pass the `!attempt.draftPrNumber` guard and each open a
// duplicate draft PR. Holding the attempt id here from the moment we
// decide to publish until the publish settles closes that window.
const publishingAttempts = new Set<string>();
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
    "Async Mission launch blocked because active executor work already claims the same path.",
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
  if (targets.length === 0 || targets.some((target) => target.kind !== "local")) {
    return prompt;
  }

  const candidatePaths = [flight?.projectPath, ...targets.map((target) => target.basePath)].filter(
    (path): path is string => Boolean(path?.trim()),
  );
  const normalized = new Set(candidatePaths.map((path) => path.replace(/\\/g, "/").toLowerCase()));
  if (normalized.size !== 1) return prompt;

  const [projectPath] = candidatePaths;
  const brief = useMemoryStore.getState().composeMemoryBrief({ kind: "local", projectPath });
  if (!brief.text.trim()) return prompt;
  return `${brief.text}\n\n---\n\n${prompt}`;
}

export const useAsyncFlightStore = create<AsyncFlightStore>(() => ({
  launchAsync: async (flightId, prompt, targets, options = {}) => {
    assertAsyncLaunchPathGate(flightId, targets, options);
    for (const target of targets) {
      await assertCostGuardrailsAllowLaunch(target.provider, flightId);
    }
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const promptForLaunch = composeAsyncLaunchPrompt(prompt, flight, targets);
    const attempts = await launchFlightAsync(flightId, promptForLaunch, targets, {
      allowPathCollisions: options.allowPathCollisions,
    });

    const flightsWithAttempts = useFlightStore.getState().flights.map((currentFlight) => {
      if (currentFlight.id !== flightId) return currentFlight;
      return {
        ...currentFlight,
        attempts: [...(currentFlight.attempts ?? []), ...attempts],
        prompt: currentFlight.prompt ?? prompt,
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
    applyAttemptsToFlightLocal(flightId, latestAttempts, prompt);

    // For each attempt, register a frontend AgentConversation that listens to
    // the same backend event channel (apiAgent*Event(sessionId)) so AttemptTile
    // can render the live stream. The backend has already started the session;
    // we pass `skipBackendStart=true`.
    const createApi = useAgentTaskStore.getState().createApiConversation;
    for (const a of attempts) {
      let sshTarget: Parameters<typeof createApi>[7] = null;
      if (a.target.kind === "ssh") {
        const server = useServerStore.getState().getServer(a.target.targetId);
        if (server) {
          sshTarget = {
            serverId: server.id,
            name: server.name,
            host: server.host,
            port: server.port,
            user: server.username,
            remotePath: a.target.basePath,
            keyPath: server.keyPath ?? null,
            authMethod: server.authMethod,
            hostFingerprint: server.hostFingerprint ?? null,
          };
        }
      }
      const projectPath = a.target.kind === "local" ? a.target.worktreePath : a.target.worktreePath;
      try {
        await createApi(
          a.agentConfigId as AgentCli,
          projectPath,
          a.model,
          prompt,
          null,
          false,
          false,
          sshTarget,
          a.sessionId, // explicitId — match backend session id
          true, // skipBackendStart — backend already started
          undefined, // allowedTools
          undefined, // memoryContextEnabled
        );
      } catch (err) {
        console.warn("Failed to attach attempt listeners:", a.id, err);
      }
    }

    return attempts;
  },

  cancelAttempt: async (flightId, attemptId) => {
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const attempt = flight?.attempts?.find((a) => a.id === attemptId);

    await cancelFlightAttempt(flightId, attemptId);
    patchAttempt(flightId, attemptId, {
      status: "cancelled",
      completedAt: Date.now(),
    });
    if (attempt) {
      detachAttemptTerminalListeners(attempt.sessionId);
    }

    // SSH worktree cleanup is deferred from the backend cancel because it
    // doesn't have full ServerConfig info — issue it from here using the
    // saved ServerConfig from serverStore (Phase 2 — was sshTargetStore).
    if (attempt && attempt.target.kind === "ssh") {
      try {
        const server = useServerStore.getState().getServer(attempt.target.targetId);
        if (server) {
          await cleanupAttemptWorktreeSsh({
            flightId,
            attemptId,
            host: server.host,
            port: server.port,
            user: server.username,
            keyPath: server.keyPath ?? null,
            basePath: attempt.target.basePath,
            targetId: server.id,
            hostFingerprint: server.hostFingerprint ?? null,
          });
        }
      } catch (err) {
        console.warn("SSH worktree cleanup failed:", err);
      }
    }
  },

  setAttemptStatus: async (flightId, attemptId, status) => {
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
    }

    // v0.8-G: post-attempt publish hook. Fire only when the attempt
    // transitions to `completed` AND the parent Flight has opted in.
    // Read the latest snapshot AFTER the patch above so we capture the
    // current branch/worktree/etc. Errors are swallowed inside the
    // helper so they never propagate out and disturb the UI flow.
    if (status === "completed") {
      const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
      const attempt = flight?.attempts?.find((a) => a.id === attemptId);
      if (
        flight &&
        attempt &&
        flight.publishAttemptsAsPrs &&
        !attempt.draftPrNumber &&
        // v0.8 race-fix: guard against two concurrent `setAttemptStatus`
        // calls both crossing the `!attempt.draftPrNumber` check before
        // either has patched the attempt with the new PR number — without
        // this set, both would each open a duplicate draft PR.
        !publishingAttempts.has(attempt.id)
      ) {
        publishingAttempts.add(attempt.id);
        // Fire-and-forget — caller doesn't need to await the publish.
        const attemptId = attempt.id;
        void publishAttemptAsDraftPr(flight, attempt).finally(() => {
          publishingAttempts.delete(attemptId);
        });
      }
    }
  },
}));
