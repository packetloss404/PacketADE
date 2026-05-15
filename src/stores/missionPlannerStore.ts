import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  apiAgentChunkEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
  apiAgentToolStartEvent,
} from "@/lib/events";
import {
  injectPlannerTurn as invokeInjectPlannerTurn,
  pauseMissionPlanner as invokePauseMissionPlanner,
  resumeMissionPlanner as invokeResumeMissionPlanner,
  startMissionPlanner as invokeStartMissionPlanner,
  stopMissionPlanner as invokeStopMissionPlanner,
} from "@/lib/tauri";

// E1 — frontend runtime for Mission Planner sessions. Ephemeral by design:
// no localStorage persistence (cold-start spec flips active planners to
// `paused` and requires user resume).

export type PlannerStatus =
  | "idle"
  | "awake"
  | "paused"
  | "quota_paused"
  | "completed"
  | "failed";

export interface PlannerTranscriptEntry {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}

export interface PlannerToolCall {
  tool: string;
  args: unknown;
  ts: number;
}

export interface PlannerSessionRuntime {
  missionId: string;
  plannerSessionId: string;
  status: PlannerStatus;
  isStreaming: boolean;
  transcript: PlannerTranscriptEntry[];
  lastToolCall: PlannerToolCall | null;
}

interface MissionPlannerStore {
  runtimes: Map<string, PlannerSessionRuntime>;
  startPlanner(missionId: string, projectPath: string): Promise<string>;
  stopPlanner(missionId: string): Promise<void>;
  pausePlanner(missionId: string): Promise<void>;
  resumePlanner(missionId: string): Promise<void>;
  injectTurn(
    missionId: string,
    content: string,
    source: "user" | "wake_trigger",
  ): Promise<void>;
  getPlanner(missionId: string): PlannerSessionRuntime | undefined;
  isPlannerRunning(missionId: string): boolean;
}

type UnlistenFn = () => void;

// Listener handles live outside the zustand state so Map equality comparisons
// (and devtools snapshots) stay clean — same approach as agentTaskStore's
// `apiConversationCleanup`.
const listenerCleanup = new Map<string, UnlistenFn>();

function patchRuntime(
  runtimes: Map<string, PlannerSessionRuntime>,
  missionId: string,
  patch: Partial<PlannerSessionRuntime>,
): Map<string, PlannerSessionRuntime> {
  const current = runtimes.get(missionId);
  if (!current) return runtimes;
  const next = new Map(runtimes);
  next.set(missionId, { ...current, ...patch });
  return next;
}

function appendTranscript(
  runtimes: Map<string, PlannerSessionRuntime>,
  missionId: string,
  entry: PlannerTranscriptEntry,
): Map<string, PlannerSessionRuntime> {
  const current = runtimes.get(missionId);
  if (!current) return runtimes;
  const next = new Map(runtimes);
  next.set(missionId, {
    ...current,
    transcript: [...current.transcript, entry],
  });
  return next;
}

async function installListeners(
  missionId: string,
  plannerSessionId: string,
  set: (
    updater: (state: MissionPlannerStore) => Partial<MissionPlannerStore>,
  ) => void,
): Promise<void> {
  const existing = listenerCleanup.get(missionId);
  if (existing) {
    existing();
    listenerCleanup.delete(missionId);
  }

  const chunkUnlisten = await listen<string>(
    apiAgentChunkEvent(plannerSessionId),
    (event) => {
      set((s) => {
        const current = s.runtimes.get(missionId);
        if (!current) return {};
        const transcript = current.transcript.slice();
        const last = transcript[transcript.length - 1];
        if (last && last.role === "assistant" && current.isStreaming) {
          transcript[transcript.length - 1] = {
            ...last,
            content: last.content + event.payload,
          };
        } else {
          transcript.push({
            role: "assistant",
            content: event.payload,
            ts: Date.now(),
          });
        }
        const runtimes = new Map(s.runtimes);
        runtimes.set(missionId, {
          ...current,
          transcript,
          isStreaming: true,
          status: current.status === "idle" ? "awake" : current.status,
        });
        return { runtimes };
      });
    },
  );

  const doneUnlisten = await listen<unknown>(
    apiAgentDoneEvent(plannerSessionId),
    () => {
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, missionId, { isStreaming: false }),
      }));
    },
  );

  const toolStartUnlisten = await listen<{ id: string; name: string; input?: unknown }>(
    apiAgentToolStartEvent(plannerSessionId),
    (event) => {
      const ts = Date.now();
      const toolName = event.payload.name;
      const args = event.payload.input ?? null;
      set((s) => {
        const next = patchRuntime(s.runtimes, missionId, {
          lastToolCall: { tool: toolName, args, ts },
        });
        return {
          runtimes: appendTranscript(next, missionId, {
            role: "system",
            content: `tool: ${toolName}`,
            ts,
          }),
        };
      });
    },
  );

  const errorUnlisten = await listen<{ message?: string }>(
    apiAgentErrorEvent(plannerSessionId),
    (event) => {
      const message = event.payload?.message ?? "planner error";
      set((s) => {
        const next = patchRuntime(s.runtimes, missionId, {
          status: "failed",
          isStreaming: false,
        });
        return {
          runtimes: appendTranscript(next, missionId, {
            role: "system",
            content: `error: ${message}`,
            ts: Date.now(),
          }),
        };
      });
    },
  );

  listenerCleanup.set(missionId, () => {
    chunkUnlisten();
    doneUnlisten();
    toolStartUnlisten();
    errorUnlisten();
  });
}

export const useMissionPlannerStore = create<MissionPlannerStore>((set, get) => ({
  runtimes: new Map(),

  startPlanner: async (missionId, projectPath) => {
    const existing = get().runtimes.get(missionId);
    if (existing) return existing.plannerSessionId;

    // Choose the planner session id up front so we can install
    // `api-agent:*` listeners BEFORE the backend spawns the sidecar.
    // Otherwise any event emitted between `invokeStartMissionPlanner`
    // returning and `installListeners` resolving — including E3's spec-
    // mode greeting `chunk` events — is silently dropped.
    const provisionalSessionId = crypto.randomUUID();

    set((s) => {
      const runtimes = new Map(s.runtimes);
      runtimes.set(missionId, {
        missionId,
        plannerSessionId: provisionalSessionId,
        status: "awake",
        isStreaming: false,
        transcript: [],
        lastToolCall: null,
      });
      return { runtimes };
    });
    await installListeners(missionId, provisionalSessionId, set);

    let plannerSessionId: string;
    try {
      plannerSessionId = await invokeStartMissionPlanner(
        missionId,
        projectPath,
        provisionalSessionId,
      );
    } catch (err) {
      // Tear down the listeners + provisional runtime so the next call
      // can re-issue cleanly. Otherwise a failed start leaves a zombie
      // runtime keyed to a never-spawned sidecar session.
      const cleanup = listenerCleanup.get(missionId);
      if (cleanup) {
        cleanup();
        listenerCleanup.delete(missionId);
      }
      set((s) => {
        if (!s.runtimes.has(missionId)) return {};
        const runtimes = new Map(s.runtimes);
        runtimes.delete(missionId);
        return { runtimes };
      });
      throw err;
    }

    // Defensive: confirm the backend honored the provisional id. If it
    // didn't (which would be a bug, given the new signature), re-install
    // listeners against the real id so events still route correctly.
    if (plannerSessionId !== provisionalSessionId) {
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, missionId, { plannerSessionId }),
      }));
      await installListeners(missionId, plannerSessionId, set);
    }
    return plannerSessionId;
  },

  stopPlanner: async (missionId) => {
    const cleanup = listenerCleanup.get(missionId);
    if (cleanup) {
      cleanup();
      listenerCleanup.delete(missionId);
    }
    set((s) => {
      if (!s.runtimes.has(missionId)) return {};
      const runtimes = new Map(s.runtimes);
      runtimes.delete(missionId);
      return { runtimes };
    });
    try {
      await invokeStopMissionPlanner(missionId);
    } catch {
      // Best-effort: backend may already have torn the session down.
    }
  },

  pausePlanner: async (missionId) => {
    await invokePauseMissionPlanner(missionId);
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, missionId, { status: "paused" }),
    }));
  },

  resumePlanner: async (missionId) => {
    await invokeResumeMissionPlanner(missionId);
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, missionId, { status: "awake" }),
    }));
  },

  injectTurn: async (missionId, content, source) => {
    const ts = Date.now();
    set((s) => {
      const current = s.runtimes.get(missionId);
      if (!current) return {};
      return {
        runtimes: appendTranscript(s.runtimes, missionId, {
          role: source === "user" ? "user" : "system",
          content,
          ts,
        }),
      };
    });
    await invokeInjectPlannerTurn(missionId, content, source);
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, missionId, { isStreaming: true }),
    }));
  },

  getPlanner: (missionId) => get().runtimes.get(missionId),

  isPlannerRunning: (missionId) => {
    const runtime = get().runtimes.get(missionId);
    if (!runtime) return false;
    return runtime.status === "awake" || runtime.status === "idle";
  },
}));
