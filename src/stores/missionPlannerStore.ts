import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  apiAgentChunkEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
  apiAgentToolStartEvent,
  missionPlannerApprovalRequestEvent,
  missionPlannerApprovalResolvedEvent,
} from "@/lib/events";
import {
  injectPlannerTurn as invokeInjectPlannerTurn,
  pauseMissionPlanner as invokePauseMissionPlanner,
  resolveMissionApproval as invokeResolveMissionApproval,
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

/**
 * E2 — async approval gate. Mirrors the Rust `MissionApprovalRequestDto`
 * shape emitted on `mission-planner:approval-request:<missionId>`. The
 * planner's `request_user_approval` tool files an approval and keeps
 * working; the UI surfaces it inline in the detail pane and routes the
 * user's answer back via `resolveMissionApproval`.
 *
 * Imported locally (rather than from `@/generated/tauri-schema`) because
 * the E2-DISP Rust slice may not have regenerated the schema yet when
 * this file compiles. Field names match the Rust serde `camelCase`
 * convention.
 */
export interface MissionApprovalRequest {
  /** Unique approval id — used as the argument to `resolveMissionApproval`. */
  id: string;
  missionId: string;
  question: string;
  /** Options the planner offered. Empty array = free-text / acknowledge only. */
  options: string[];
  /** Epoch ms when the planner filed the approval. */
  awaitingSince: number;
}

interface MissionPlannerStore {
  runtimes: Map<string, PlannerSessionRuntime>;
  /** E2 — per-mission queue of unresolved approval requests, oldest first. */
  pendingApprovals: Map<string, MissionApprovalRequest[]>;
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
  /**
   * E2 — resolve an approval gate. Calls the Rust binding then drops the
   * approval from local state on success. On failure the approval stays
   * pending so the user can retry; the error is rethrown.
   */
  resolveApproval(
    missionId: string,
    approvalId: string,
    choice: string,
  ): Promise<void>;
  /** Returns pending approvals for `missionId`, sorted oldest-first. */
  getPendingApprovals(missionId: string): MissionApprovalRequest[];
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

  // E2 — async approval gate. Append to the per-mission queue so the
  // detail pane's PlannerApprovalGate can surface the oldest one first.
  const approvalRequestUnlisten = await listen<MissionApprovalRequest>(
    missionPlannerApprovalRequestEvent(missionId),
    (event) => {
      const approval = event.payload;
      if (!approval || !approval.id) return;
      set((s) => {
        const pending = new Map(s.pendingApprovals);
        const list = pending.get(missionId) ?? [];
        // De-dupe: ignore duplicate request events for the same approval id.
        if (list.some((a) => a.id === approval.id)) return {};
        pending.set(missionId, [...list, approval]);
        return { pendingApprovals: pending };
      });
    },
  );

  // E2 — resolution events from the Rust side (e.g. another window, or
  // a planner-driven auto-resolve). Mirror the local state. The resolve
  // action itself also clears state for fast UI feedback, so this is
  // mostly belt-and-braces for cross-tab/cross-window sync.
  const approvalResolvedUnlisten = await listen<{ id?: string }>(
    missionPlannerApprovalResolvedEvent(missionId),
    (event) => {
      const approvalId = event.payload?.id;
      if (!approvalId) return;
      set((s) => {
        const list = s.pendingApprovals.get(missionId);
        if (!list || list.length === 0) return {};
        const filtered = list.filter((a) => a.id !== approvalId);
        if (filtered.length === list.length) return {};
        const pending = new Map(s.pendingApprovals);
        if (filtered.length === 0) {
          pending.delete(missionId);
        } else {
          pending.set(missionId, filtered);
        }
        return { pendingApprovals: pending };
      });
    },
  );

  listenerCleanup.set(missionId, () => {
    chunkUnlisten();
    doneUnlisten();
    toolStartUnlisten();
    errorUnlisten();
    approvalRequestUnlisten();
    approvalResolvedUnlisten();
  });
}

export const useMissionPlannerStore = create<MissionPlannerStore>((set, get) => ({
  runtimes: new Map(),
  pendingApprovals: new Map(),

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
      const runtimes = new Map(s.runtimes);
      const pendingApprovals = new Map(s.pendingApprovals);
      const hadRuntime = runtimes.delete(missionId);
      const hadApprovals = pendingApprovals.delete(missionId);
      if (!hadRuntime && !hadApprovals) return {};
      return { runtimes, pendingApprovals };
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

  resolveApproval: async (missionId, approvalId, choice) => {
    // Optimistically drop the approval from local state so the UI hides
    // immediately. If the backend call fails we restore it.
    let snapshot: MissionApprovalRequest[] | null = null;
    set((s) => {
      const list = s.pendingApprovals.get(missionId);
      if (!list || list.length === 0) return {};
      snapshot = list;
      const filtered = list.filter((a) => a.id !== approvalId);
      if (filtered.length === list.length) {
        snapshot = null;
        return {};
      }
      const pending = new Map(s.pendingApprovals);
      if (filtered.length === 0) {
        pending.delete(missionId);
      } else {
        pending.set(missionId, filtered);
      }
      return { pendingApprovals: pending };
    });

    try {
      await invokeResolveMissionApproval(approvalId, choice);
    } catch (err) {
      // Restore the snapshot so the user can retry.
      if (snapshot) {
        set((s) => {
          const pending = new Map(s.pendingApprovals);
          pending.set(missionId, snapshot as MissionApprovalRequest[]);
          return { pendingApprovals: pending };
        });
      }
      throw err;
    }
  },

  getPendingApprovals: (missionId) => {
    const list = get().pendingApprovals.get(missionId);
    if (!list || list.length === 0) return [];
    // Oldest-first.
    return [...list].sort((a, b) => a.awaitingSince - b.awaitingSince);
  },
}));
