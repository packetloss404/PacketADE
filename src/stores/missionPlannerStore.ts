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
  getMissionApprovals as invokeGetMissionApprovals,
  injectPlannerTurn as invokeInjectPlannerTurn,
  pauseMissionPlanner as invokePauseMissionPlanner,
  resolveMissionApproval as invokeResolveMissionApproval,
  resumeMissionPlanner as invokeResumeMissionPlanner,
  startMissionPlanner as invokeStartMissionPlanner,
  stopMissionPlanner as invokeStopMissionPlanner,
  triggerPlannerDecomposition as invokeTriggerPlannerDecomposition,
} from "@/lib/tauri";
import { notifyMissionPlannerRateLimited } from "@/lib/notifications";
import { useFlightStore } from "@/stores/flightStore";

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
  /**
   * E3-LAUNCH — armed to `true` by `launchMission` (after the `spec ->
   * planning` flip, before the [LAUNCH] turn is injected) and consumed
   * by the very next `api-agent:tool-start` event, which flips the
   * flight from `planning` to `active`.
   *
   * Initialized `false` at `startPlanner` so spec-mode tool calls (e.g.
   * `request_user_approval` during pre-launch chat) don't burn the flag.
   * The kickoff is armed only between `launchMission` and the first
   * post-launch tool-start, matching the user-facing semantics
   * "Launch -> first planner tool means we're active".
   */
  awaitingLaunchKickoff: boolean;
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
  /**
   * E3-LAUNCH — transition a mission from `spec` to `planning`, then poke
   * the planner with the `[LAUNCH]` sentinel so it begins decomposition.
   * The flight auto-transitions to `active` when the first
   * `create_milestone` / `create_task` tool-start event lands.
   */
  launchMission(missionId: string): Promise<void>;
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
      // E3-LAUNCH — only consume the kickoff flag if it was armed by
      // `launchMission`. Tool calls during spec-mode chat (e.g.
      // `request_user_approval`) MUST NOT burn it. Capture inside the
      // set() updater so the read+clear is atomic against any other
      // listener mutating the same runtime concurrently.
      let shouldFlipToActive = false;
      set((s) => {
        const current = s.runtimes.get(missionId);
        if (!current) return {};
        const wasAwaitingKickoff = current.awaitingLaunchKickoff;
        if (wasAwaitingKickoff) {
          shouldFlipToActive = true;
        }
        const runtimes = new Map(s.runtimes);
        runtimes.set(missionId, {
          ...current,
          lastToolCall: { tool: toolName, args, ts },
          awaitingLaunchKickoff: wasAwaitingKickoff
            ? false
            : current.awaitingLaunchKickoff,
          transcript: [
            ...current.transcript,
            { role: "system", content: `tool: ${toolName}`, ts },
          ],
        });
        return { runtimes };
      });
      if (shouldFlipToActive) {
        // Kickoff tool landed after Launch -> flip the flight to `active`
        // if it's still in the `planning` state. Guarded on flight status
        // so we don't clobber `paused`/`failed`/etc. transitions.
        const flightStore = useFlightStore.getState();
        const flight = flightStore.flights.find((f) => f.id === missionId);
        if (flight?.status === "planning") {
          flightStore.updateFlight(missionId, { status: "active" });
        }
      }
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

  // E6-CEILING-RATELIMIT — desktop notification + status flip when the
  // Anthropic provider returns a rate-limit error. The Rust supervisor's
  // `MissionPlannerRegistry::on_rate_limited` flips the planner into
  // `QuotaPaused` and emits this per-mission event with the effective
  // wait-seconds; we mirror that into the runtime so the UI's PlannerStatusChip
  // surfaces the right state without waiting for a wake round-trip,
  // and fire a desktop notification so the user knows the mission
  // isn't frozen.
  const rateLimitedUnlisten = await listen<{
    missionId: string;
    retryAfterSeconds: number;
  }>(`mission-planner:rate-limited:${missionId}`, (event) => {
    const waitSeconds = event.payload?.retryAfterSeconds ?? 60;
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, missionId, {
        status: "quota_paused",
        isStreaming: false,
      }),
    }));
    const flight = useFlightStore
      .getState()
      .flights.find((f) => f.id === missionId);
    const missionTitle = flight?.title ?? "Mission";
    void notifyMissionPlannerRateLimited(
      missionId,
      missionTitle,
      waitSeconds,
    );
  });

  // FIX 3 — generic status-changed event emitted by
  // `MissionPlannerRegistry::set_status_and_emit` from the Rust side
  // (manual pause / resume, kill-switch, and any future call site that
  // wants UI propagation). Pattern matches the rate-limited listener
  // above but accepts any PlannerStatus.
  //
  // The Rust payload is `{ missionId, status }` where status serializes
  // via PlannerStatus's `serde(rename_all = "snake_case")` derive into
  // one of: idle / awake / paused / quota_paused / completed / failed —
  // exactly the union shape of the local `PlannerStatus` TS type.
  const statusChangedUnlisten = await listen<{
    missionId: string;
    status: PlannerStatus;
  }>(`mission-planner:status-changed:${missionId}`, (event) => {
    const nextStatus = event.payload?.status;
    if (!nextStatus) return;
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, missionId, { status: nextStatus }),
    }));
  });

  // E3-FIX1 — refresh `flightStore` whenever the Rust planner tool
  // handlers mutate persisted flight state. Without these, the planner
  // populates PersistedState on disk but `MilestonesCard` / `TimelineCard`
  // stay empty until app reload, breaking the headline acceptance test.
  //
  // All 8 events are scoped to `missionId` and the Rust side emits them
  // unconditionally on success (see `commands/mission_planner_tools/*.rs`,
  // search for `format!("mission-planner:`). We call the existing
  // `hydrateFromBackend` on each fire — it re-reads the whole
  // PersistedState, which is the right hammer for v1. A targeted
  // "refresh-this-flight-only" would be more efficient but isn't needed
  // for correctness (P3 follow-up).
  const flightEventKinds = [
    "milestone-created",
    "task-created",
    "task-started",
    "task-launch-failed",
    "task-updated",
    "task-blocked",
    "task-replan-acknowledged",
    "mission-completed",
    // E8-UI — sibling E8-ACCUM emits `mission-planner:cost-updated:<missionId>`
    // when the planner accumulates new tokens/cost. Same handling as the
    // other planner-side mutations: re-hydrate flightStore so StatGrid's
    // Planner / Exec cells reflect the latest numbers.
    "cost-updated",
  ] as const;
  const flightEventUnlistens: UnlistenFn[] = [];
  for (const kind of flightEventKinds) {
    const unlisten = await listen(
      `mission-planner:${kind}:${missionId}`,
      () => {
        // Best-effort re-read; surface failures to the console so we can
        // diagnose schema-drift issues without crashing the planner UI.
        void useFlightStore
          .getState()
          .hydrateFromBackend()
          .catch((err) => {
            console.warn(
              `Failed to hydrate flightStore after mission-planner:${kind}`,
              missionId,
              err,
            );
          });
      },
    );
    flightEventUnlistens.push(unlisten);
  }

  listenerCleanup.set(missionId, () => {
    chunkUnlisten();
    doneUnlisten();
    toolStartUnlisten();
    errorUnlisten();
    approvalRequestUnlisten();
    approvalResolvedUnlisten();
    rateLimitedUnlisten();
    statusChangedUnlisten();
    for (const unlisten of flightEventUnlistens) {
      unlisten();
    }
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
        awaitingLaunchKickoff: false,
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

    // E3-LAUNCH / E3-HYD coordination — hydrate any pending approval
    // requests that were persisted by the Rust side. Live events will catch
    // new approvals; this only matters on app restart or view re-mount
    // while a planner is mid-flight. Non-fatal on error.
    try {
      const existing = await invokeGetMissionApprovals(missionId);
      if (existing.length > 0) {
        // Merge by id rather than replace: a live `approval-request`
        // event may have landed in the ~1ms gap between `installListeners`
        // resolving and this hydration call returning, and replacing the
        // map outright would drop those entries on the floor.
        set((s) => {
          const updated = new Map(s.pendingApprovals);
          const current = updated.get(missionId) ?? [];
          const currentNotInExisting = current.filter(
            (c) => !existing.some((e) => e.id === c.id),
          );
          updated.set(missionId, [...existing, ...currentNotInExisting]);
          return { pendingApprovals: updated };
        });
      }
    } catch (err) {
      console.warn(
        "Failed to hydrate pending approvals for mission",
        missionId,
        err,
      );
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

  launchMission: async (missionId) => {
    const runtime = get().runtimes.get(missionId);
    if (!runtime) {
      throw new Error(
        `launchMission: planner not started for mission ${missionId}. ` +
          "Call startPlanner first (spec-mode chat must be live).",
      );
    }

    // Optimistic system line so the user has visual feedback before the
    // planner's first stream chunk arrives.
    set((s) => ({
      runtimes: appendTranscript(s.runtimes, missionId, {
        role: "system",
        content: "Launching mission…",
        ts: Date.now(),
      }),
    }));

    // Flip `spec` -> `planning`. The detail pane (E3-MOUNT) listens on the
    // flight status to swap MissionSpecPane back to the milestones/timeline
    // view, so the user sees create_milestone / create_task calls land
    // live.
    useFlightStore.getState().updateFlight(missionId, { status: "planning" });

    // Arm the kickoff flag. The next `api-agent:tool-start` for this
    // planner consumes the flag and flips `planning -> active`. Done
    // AFTER the status flip and BEFORE the wake fires so a hypothetical
    // racing pre-launch tool can't accidentally trip the flip.
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, missionId, {
        awaitingLaunchKickoff: true,
        // Surface as `isStreaming: true` so the chat UI shows the
        // pending indicator while the planner's first decomposition
        // turn streams in. The `done` event handler will clear it.
        isStreaming: true,
      }),
    }));

    // Fire a `WakeTrigger::Decomposition` event into the planner's
    // wake bus instead of hand-crafting a user message. The Rust wake
    // consumer:
    //   1. enriches the snapshot via `build_wake_payload` (reads the
    //      Flight DTO from PersistedState),
    //   2. formats the body via `wake_user_message` → `render_decomposition`
    //      (the planner's own hand-authored decomposition prompt), and
    //   3. injects with `kind="launch"`, which the planner's system
    //      prompt is trained to recognize as the kickoff trigger.
    //
    // The previous `injectTurn(..., "wake_trigger")` path mis-tagged
    // the kind as `"user_message_in_journal"`, so the planner never
    // saw a `kind="launch"` wake and `render_decomposition`'s body
    // was unreachable from the UI.
    try {
      await invokeTriggerPlannerDecomposition(missionId);
    } catch (err) {
      // If the wake failed to enqueue, roll back the flight status,
      // disarm the kickoff flag, and clear the streaming indicator so
      // the user can retry. The optimistic "Launching mission…" line
      // stays in the transcript as a breadcrumb (the error event
      // listener may also append an `error:` line).
      useFlightStore.getState().updateFlight(missionId, { status: "spec" });
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, missionId, {
          awaitingLaunchKickoff: false,
          isStreaming: false,
        }),
      }));
      throw err;
    }
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
