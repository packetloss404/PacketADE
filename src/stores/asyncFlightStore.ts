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
import type { Attempt, AttemptStatus, Flight } from "@/types/flight";

interface AsyncFlightStore {
  /** Launch N parallel attempts on a Flight. Persists Attempts on the Flight. */
  launchAsync: (
    flightId: string,
    prompt: string,
    targets: AttemptTargetSpec[],
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

function applyAttemptsToFlight(flightId: string, attempts: Attempt[]) {
  const flight = useFlightStore
    .getState()
    .flights.find((f) => f.id === flightId);
  if (!flight) return;
  const merged = [...(flight.attempts ?? []), ...attempts];
  useFlightStore.getState().updateFlight(flightId, { attempts: merged, prompt: undefined });
}

function patchAttempt(
  flightId: string,
  attemptId: string,
  patch: Partial<Attempt>,
) {
  const flight = useFlightStore
    .getState()
    .flights.find((f) => f.id === flightId);
  if (!flight || !flight.attempts) return;
  const next = flight.attempts.map((a) =>
    a.id === attemptId ? { ...a, ...patch } : a,
  );
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
async function publishAttemptAsDraftPr(
  flight: Flight,
  attempt: Attempt,
): Promise<void> {
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
    const msg = typeof err === "string" ? err : (err as Error)?.message ?? "push failed";
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
    const msg = typeof err === "string" ? err : (err as Error)?.message ?? "create_pr failed";
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
    const msg =
      typeof err === "string" ? err : (err as Error)?.message ?? "unknown error";
    console.warn(
      "publishAttemptAsDraftPr: failed to persist draft PR number",
      attempt.id,
      err,
    );
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

export const useAsyncFlightStore = create<AsyncFlightStore>(() => ({
  launchAsync: async (flightId, prompt, targets) => {
    const attempts = await launchFlightAsync(flightId, prompt, targets);

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
            hostFingerprint: server.hostFingerprint ?? null,
          };
        }
      }
      const projectPath =
        a.target.kind === "local"
          ? a.target.worktreePath
          : a.target.worktreePath;
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
          a.sessionId,    // explicitId — match backend session id
          true,           // skipBackendStart — backend already started
          undefined,      // allowedTools
          undefined,      // memoryContextEnabled
        );
      } catch (err) {
        console.warn("Failed to attach attempt listeners:", a.id, err);
      }
    }

    // Persist the prompt + attempts onto the Flight.
    const flight = useFlightStore
      .getState()
      .flights.find((f) => f.id === flightId);
    if (flight) {
      const merged = [...(flight.attempts ?? []), ...attempts];
      useFlightStore.getState().updateFlight(flightId, {
        attempts: merged,
        prompt: flight.prompt ?? prompt,
      });
    } else {
      applyAttemptsToFlight(flightId, attempts);
    }
    return attempts;
  },

  cancelAttempt: async (flightId, attemptId) => {
    const flight = useFlightStore
      .getState()
      .flights.find((f) => f.id === flightId);
    const attempt = flight?.attempts?.find((a) => a.id === attemptId);

    await cancelFlightAttempt(flightId, attemptId);
    patchAttempt(flightId, attemptId, {
      status: "cancelled",
      completedAt: Date.now(),
    });

    // SSH worktree cleanup is deferred from the backend cancel because it
    // doesn't have full ServerConfig info — issue it from here using the
    // saved ServerConfig from serverStore (Phase 2 — was sshTargetStore).
    if (attempt && attempt.target.kind === "ssh") {
      try {
        const server = useServerStore
          .getState()
          .getServer(attempt.target.targetId);
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

    // v0.8-G: post-attempt publish hook. Fire only when the attempt
    // transitions to `completed` AND the parent Flight has opted in.
    // Read the latest snapshot AFTER the patch above so we capture the
    // current branch/worktree/etc. Errors are swallowed inside the
    // helper so they never propagate out and disturb the UI flow.
    if (status === "completed") {
      const flight = useFlightStore
        .getState()
        .flights.find((f) => f.id === flightId);
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
