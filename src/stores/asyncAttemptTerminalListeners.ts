import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { apiAgentDoneEvent, apiAgentErrorEvent } from "@/lib/events";
import { notifyAttemptCompleted } from "@/lib/notifications";
import { useFlightStore } from "@/stores/flightStore";
import type { Attempt, AttemptStatus } from "@/types/flight";

const attemptTerminalCleanups = new Map<string, UnlistenFn[]>();

function patchAttempt(flightId: string, attemptId: string, patch: Partial<Attempt>) {
  const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
  if (!flight || !flight.attempts) return;
  const next = flight.attempts.map((a) => (a.id === attemptId ? { ...a, ...patch } : a));
  useFlightStore.getState().updateFlight(flightId, { attempts: next });
}

function attemptLabel(attempt: Attempt): string {
  return attempt.target.kind === "ssh" ? attempt.target.targetId : "local";
}

function currentAttempt(flightId: string, attemptId: string): Attempt | undefined {
  return useFlightStore
    .getState()
    .flights.find((f) => f.id === flightId)
    ?.attempts?.find((a) => a.id === attemptId);
}

function terminalStatusIsActive(status: AttemptStatus | undefined): boolean {
  return status === "running" || status === "provisioning";
}

async function transitionAttemptStatus(
  flightId: string,
  attemptId: string,
  status: Extract<AttemptStatus, "reviewing" | "failed">,
  errorMessage?: string,
) {
  const { markAttemptStatus } = await import("@/lib/tauri");
  await markAttemptStatus(flightId, attemptId, status);
  patchAttempt(flightId, attemptId, {
    status,
    ...(status === "failed" ? { completedAt: Date.now() } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  });
}

export function detachAttemptTerminalListeners(sessionId: string) {
  const unlisteners = attemptTerminalCleanups.get(sessionId);
  if (!unlisteners) return;
  attemptTerminalCleanups.delete(sessionId);
  for (const unlisten of unlisteners) {
    try {
      unlisten();
    } catch {
      // best-effort detach
    }
  }
}

async function ensureAttemptTerminalListeners(flightId: string, attempt: Attempt): Promise<void> {
  if (attemptTerminalCleanups.has(attempt.sessionId)) return;

  const unlisteners: UnlistenFn[] = [];
  attemptTerminalCleanups.set(attempt.sessionId, unlisteners);

  const doneReady = listen(apiAgentDoneEvent(attempt.sessionId), () => {
    // Defer one macrotask so the normal api-agent conversation listener can
    // finalize the assistant message first. The attempt transition is owned
    // here, not by AttemptTile, so it survives route changes and unmounted UI.
    setTimeout(() => {
      const fresh = currentAttempt(flightId, attempt.id);
      if (!terminalStatusIsActive(fresh?.status)) return;

      void transitionAttemptStatus(flightId, attempt.id, "reviewing").then(() => {
        const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
        if (flight) void notifyAttemptCompleted(flight.title, attemptLabel(attempt));
      });
    }, 0);
  }).then((unlisten) => {
    if (attemptTerminalCleanups.has(attempt.sessionId)) {
      unlisteners.push(unlisten);
    } else {
      unlisten();
    }
  });

  const errorReady = listen<{ message?: string }>(
    apiAgentErrorEvent(attempt.sessionId),
    (event) => {
      const fresh = currentAttempt(flightId, attempt.id);
      if (!terminalStatusIsActive(fresh?.status)) return;

      void transitionAttemptStatus(flightId, attempt.id, "failed", event.payload?.message).then(
        () => {
          detachAttemptTerminalListeners(attempt.sessionId);
        },
      );
    },
  ).then((unlisten) => {
    if (attemptTerminalCleanups.has(attempt.sessionId)) {
      unlisteners.push(unlisten);
    } else {
      unlisten();
    }
  });

  await Promise.all([doneReady, errorReady]);
}

export async function syncAsyncAttemptTerminalListeners(
  flights = useFlightStore.getState().flights,
): Promise<void> {
  const activeSessionIds = new Set<string>();
  const registrations: Promise<void>[] = [];
  for (const flight of flights) {
    for (const attempt of flight.attempts ?? []) {
      if (!terminalStatusIsActive(attempt.status)) continue;
      activeSessionIds.add(attempt.sessionId);
      registrations.push(ensureAttemptTerminalListeners(flight.id, attempt));
    }
  }

  for (const sessionId of Array.from(attemptTerminalCleanups.keys())) {
    if (!activeSessionIds.has(sessionId)) {
      detachAttemptTerminalListeners(sessionId);
    }
  }

  await Promise.all(registrations);
}

if (typeof useFlightStore.subscribe === "function") {
  useFlightStore.subscribe((state) => {
    void syncAsyncAttemptTerminalListeners(state.flights);
  });
}
