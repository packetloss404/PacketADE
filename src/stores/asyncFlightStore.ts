import { create } from "zustand";
import {
  launchFlightAsync,
  cancelFlightAttempt,
  cleanupAttemptWorktreeSsh,
  markAttemptStatus,
  type AttemptTargetSpec,
} from "@/lib/tauri";
import { useFlightStore } from "@/stores/flightStore";
import { useAgentTaskStore, type AgentCli } from "@/stores/agentTaskStore";
import { useServerStore } from "@/stores/serverStore";
import type { Attempt, AttemptStatus } from "@/types/flight";

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
  },
}));
