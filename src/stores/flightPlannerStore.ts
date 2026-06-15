import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  apiAgentChunkEvent,
  apiAgentDoneEvent,
  apiAgentErrorEvent,
  apiAgentToolStartEvent,
  flightPlannerApprovalRequestEvent,
  flightPlannerApprovalResolvedEvent,
} from "@/lib/events";
import {
  getFlightApprovals as invokeGetFlightApprovals,
  injectPlannerTurn as invokeInjectPlannerTurn,
  pauseFlightPlanner as invokePauseFlightPlanner,
  resolveFlightApproval as invokeResolveFlightApproval,
  resumeFlightPlanner as invokeResumeFlightPlanner,
  startFlightPlanner as invokeStartFlightPlanner,
  stopFlightPlanner as invokeStopFlightPlanner,
  triggerPlannerDecomposition as invokeTriggerPlannerDecomposition,
} from "@/lib/tauri";
import { notifyFlightPlannerRateLimited } from "@/lib/notifications";
import { syncAsyncAttemptTerminalListeners } from "@/stores/asyncAttemptTerminalListeners";
import { useFlightStore } from "@/stores/flightStore";

// E1 — frontend runtime for Flight Planner sessions. Ephemeral by design:
// no localStorage persistence (cold-start spec flips active planners to
// `paused` and requires user resume).

export type PlannerStatus = "idle" | "awake" | "paused" | "quota_paused" | "completed" | "failed";

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
  flightId: string;
  plannerSessionId: string;
  status: PlannerStatus;
  isStreaming: boolean;
  transcript: PlannerTranscriptEntry[];
  lastToolCall: PlannerToolCall | null;
  /**
   * E3-LAUNCH — armed to `true` by `launchFlight` (after the `spec ->
   * planning` flip, before the [LAUNCH] turn is injected) and consumed
   * by the very next `api-agent:tool-start` event, which flips the
   * flight from `planning` to `active`.
   *
   * Initialized `false` at `startPlanner` so spec-mode tool calls (e.g.
   * `request_user_approval` during pre-launch chat) don't burn the flag.
   * The kickoff is armed only between `launchFlight` and the first
   * post-launch tool-start, matching the user-facing semantics
   * "Launch -> first planner tool means we're active".
   */
  awaitingLaunchKickoff: boolean;
  /**
   * E10 — transient flag set when the Rust planner crosses the
   * 150K-token compaction threshold and is summarizing the conversation
   * to swap in a fresh session. Flips `true` on
   * `flight-planner:compaction-triggered:<flightId>` and `false` on
   * `flight-planner:compaction-completed:<flightId>`. The detail pane
   * surfaces this as a small "Compacting" pill in the header so the
   * user understands why the planner may be unresponsive for a few
   * seconds. Not persisted — purely UI feedback.
   */
  isCompacting: boolean;
}

/**
 * E2 — async approval gate. Mirrors the Rust `FlightApprovalRequestDto`
 * shape emitted on `flight-planner:approval-request:<flightId>`. The
 * planner's `request_user_approval` tool files an approval and keeps
 * working; the UI surfaces it inline in the detail pane and routes the
 * user's answer back via `resolveFlightApproval`.
 *
 * Imported locally (rather than from `@/generated/tauri-schema`) because
 * the E2-DISP Rust slice may not have regenerated the schema yet when
 * this file compiles. Field names match the Rust serde `camelCase`
 * convention.
 */
export interface FlightApprovalRequest {
  /** Unique approval id — used as the argument to `resolveFlightApproval`. */
  id: string;
  flightId: string;
  question: string;
  /** Options the planner offered. Empty array = free-text / acknowledge only. */
  options: string[];
  /** Epoch ms when the planner filed the approval. */
  awaitingSince: number;
}

interface FlightPlannerStore {
  runtimes: Map<string, PlannerSessionRuntime>;
  /** E2 — per-flight queue of unresolved approval requests, oldest first. */
  pendingApprovals: Map<string, FlightApprovalRequest[]>;
  startPlanner(flightId: string, projectPath: string): Promise<string>;
  stopPlanner(flightId: string): Promise<void>;
  pausePlanner(flightId: string): Promise<void>;
  resumePlanner(flightId: string): Promise<void>;
  injectTurn(flightId: string, content: string, source: "user" | "wake_trigger"): Promise<void>;
  /**
   * E3-LAUNCH — transition a flight from `spec` to `planning`, then poke
   * the planner with the `[LAUNCH]` sentinel so it begins decomposition.
   * The flight auto-transitions to `active` when the first
   * `create_milestone` / `create_task` tool-start event lands.
   */
  launchFlight(flightId: string): Promise<void>;
  getPlanner(flightId: string): PlannerSessionRuntime | undefined;
  isPlannerRunning(flightId: string): boolean;
  /**
   * E2 — resolve an approval gate. Calls the Rust binding then drops the
   * approval from local state on success. On failure the approval stays
   * pending so the user can retry; the error is rethrown.
   */
  resolveApproval(flightId: string, approvalId: string, choice: string): Promise<void>;
  /**
   * E2 continuity — hydrate unresolved approvals from persisted state without
   * requiring a live planner runtime. Used by the Flight detail approval gate
   * after cold start / view remount.
   */
  hydratePendingApprovals(flightId: string): Promise<void>;
  /** Returns pending approvals for `flightId`, sorted oldest-first. */
  getPendingApprovals(flightId: string): FlightApprovalRequest[];
}

type UnlistenFn = () => void;

// Listener handles live outside the zustand state so Map equality comparisons
// (and devtools snapshots) stay clean — same approach as agentTaskStore's
// `apiConversationCleanup`.
const listenerCleanup = new Map<string, UnlistenFn>();

function patchRuntime(
  runtimes: Map<string, PlannerSessionRuntime>,
  flightId: string,
  patch: Partial<PlannerSessionRuntime>,
): Map<string, PlannerSessionRuntime> {
  const current = runtimes.get(flightId);
  if (!current) return runtimes;
  const next = new Map(runtimes);
  next.set(flightId, { ...current, ...patch });
  return next;
}

function appendTranscript(
  runtimes: Map<string, PlannerSessionRuntime>,
  flightId: string,
  entry: PlannerTranscriptEntry,
): Map<string, PlannerSessionRuntime> {
  const current = runtimes.get(flightId);
  if (!current) return runtimes;
  const next = new Map(runtimes);
  next.set(flightId, {
    ...current,
    transcript: [...current.transcript, entry],
  });
  return next;
}

function mergePendingApprovals(
  pendingApprovals: Map<string, FlightApprovalRequest[]>,
  flightId: string,
  approvals: FlightApprovalRequest[],
  preserveExistingMissing: boolean,
): Map<string, FlightApprovalRequest[]> {
  const updated = new Map(pendingApprovals);
  const current = updated.get(flightId) ?? [];
  const byId = new Map<string, FlightApprovalRequest>();

  for (const approval of approvals) {
    byId.set(approval.id, approval);
  }
  if (preserveExistingMissing) {
    for (const approval of current) {
      if (!byId.has(approval.id)) {
        byId.set(approval.id, approval);
      }
    }
  }

  const merged = [...byId.values()].sort((a, b) => a.awaitingSince - b.awaitingSince);
  if (merged.length === 0) {
    updated.delete(flightId);
  } else {
    updated.set(flightId, merged);
  }
  return updated;
}

async function installListeners(
  flightId: string,
  plannerSessionId: string,
  set: (updater: (state: FlightPlannerStore) => Partial<FlightPlannerStore>) => void,
): Promise<void> {
  const existing = listenerCleanup.get(flightId);
  if (existing) {
    existing();
    listenerCleanup.delete(flightId);
  }

  const chunkUnlisten = await listen<string>(apiAgentChunkEvent(plannerSessionId), (event) => {
    set((s) => {
      const current = s.runtimes.get(flightId);
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
      runtimes.set(flightId, {
        ...current,
        transcript,
        isStreaming: true,
        status: current.status === "idle" ? "awake" : current.status,
      });
      return { runtimes };
    });
  });

  const doneUnlisten = await listen<unknown>(apiAgentDoneEvent(plannerSessionId), () => {
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, { isStreaming: false }),
    }));
  });

  const toolStartUnlisten = await listen<{ id: string; name: string; input?: unknown }>(
    apiAgentToolStartEvent(plannerSessionId),
    (event) => {
      const ts = Date.now();
      const toolName = event.payload.name;
      const args = event.payload.input ?? null;
      // E3-LAUNCH — only consume the kickoff flag if it was armed by
      // `launchFlight`. Tool calls during spec-mode chat (e.g.
      // `request_user_approval`) MUST NOT burn it. Capture inside the
      // set() updater so the read+clear is atomic against any other
      // listener mutating the same runtime concurrently.
      let shouldFlipToActive = false;
      set((s) => {
        const current = s.runtimes.get(flightId);
        if (!current) return {};
        const wasAwaitingKickoff = current.awaitingLaunchKickoff;
        if (wasAwaitingKickoff) {
          shouldFlipToActive = true;
        }
        const runtimes = new Map(s.runtimes);
        runtimes.set(flightId, {
          ...current,
          lastToolCall: { tool: toolName, args, ts },
          awaitingLaunchKickoff: wasAwaitingKickoff ? false : current.awaitingLaunchKickoff,
          transcript: [...current.transcript, { role: "system", content: `tool: ${toolName}`, ts }],
        });
        return { runtimes };
      });
      if (shouldFlipToActive) {
        // Kickoff tool landed after Launch -> flip the flight to `active`
        // if it's still in the `planning` state. Guarded on flight status
        // so we don't clobber `paused`/`failed`/etc. transitions.
        const flightStore = useFlightStore.getState();
        const flight = flightStore.flights.find((f) => f.id === flightId);
        if (flight?.status === "planning") {
          flightStore.updateFlight(flightId, { status: "active" });
        }
      }
    },
  );

  const errorUnlisten = await listen<{ message?: string }>(
    apiAgentErrorEvent(plannerSessionId),
    (event) => {
      const message = event.payload?.message ?? "planner error";
      set((s) => {
        const next = patchRuntime(s.runtimes, flightId, {
          status: "failed",
          isStreaming: false,
        });
        return {
          runtimes: appendTranscript(next, flightId, {
            role: "system",
            content: `error: ${message}`,
            ts: Date.now(),
          }),
        };
      });
    },
  );

  // E2 — async approval gate. Append to the per-flight queue so the
  // detail pane's PlannerApprovalGate can surface the oldest one first.
  const approvalRequestUnlisten = await listen<FlightApprovalRequest>(
    flightPlannerApprovalRequestEvent(flightId),
    (event) => {
      const approval = event.payload;
      if (!approval || !approval.id) return;
      set((s) => {
        const pending = new Map(s.pendingApprovals);
        const list = pending.get(flightId) ?? [];
        // De-dupe: ignore duplicate request events for the same approval id.
        if (list.some((a) => a.id === approval.id)) return {};
        pending.set(flightId, [...list, approval]);
        return { pendingApprovals: pending };
      });
    },
  );

  // E2 — resolution events from the Rust side (e.g. another window, or
  // a planner-driven auto-resolve). Mirror the local state. The resolve
  // action itself also clears state for fast UI feedback, so this is
  // mostly belt-and-braces for cross-tab/cross-window sync.
  const approvalResolvedUnlisten = await listen<{ id?: string }>(
    flightPlannerApprovalResolvedEvent(flightId),
    (event) => {
      const approvalId = event.payload?.id;
      if (!approvalId) return;
      set((s) => {
        const list = s.pendingApprovals.get(flightId);
        if (!list || list.length === 0) return {};
        const filtered = list.filter((a) => a.id !== approvalId);
        if (filtered.length === list.length) return {};
        const pending = new Map(s.pendingApprovals);
        if (filtered.length === 0) {
          pending.delete(flightId);
        } else {
          pending.set(flightId, filtered);
        }
        return { pendingApprovals: pending };
      });
    },
  );

  // E6-CEILING-RATELIMIT — desktop notification + status flip when the
  // Anthropic provider returns a rate-limit error. The Rust supervisor's
  // `FlightPlannerRegistry::on_rate_limited` flips the planner into
  // `QuotaPaused` and emits this per-flight event with the effective
  // wait-seconds; we mirror that into the runtime so the UI's PlannerStatusChip
  // surfaces the right state without waiting for a wake round-trip,
  // and fire a desktop notification so the user knows the flight
  // isn't frozen.
  const rateLimitedUnlisten = await listen<{
    flightId: string;
    retryAfterSeconds: number;
  }>(`flight-planner:rate-limited:${flightId}`, (event) => {
    const waitSeconds = event.payload?.retryAfterSeconds ?? 60;
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, {
        status: "quota_paused",
        isStreaming: false,
      }),
    }));
    const flight = useFlightStore.getState().flights.find((f) => f.id === flightId);
    const flightTitle = flight?.title ?? "Flight";
    void notifyFlightPlannerRateLimited(flightId, flightTitle, waitSeconds);
  });

  // FIX 3 — generic status-changed event emitted by
  // `FlightPlannerRegistry::set_status_and_emit` from the Rust side
  // (manual pause / resume, kill-switch, and any future call site that
  // wants UI propagation). Pattern matches the rate-limited listener
  // above but accepts any PlannerStatus.
  //
  // The Rust payload is `{ flightId, status }` where status serializes
  // via PlannerStatus's `serde(rename_all = "snake_case")` derive into
  // one of: idle / awake / paused / quota_paused / completed / failed —
  // exactly the union shape of the local `PlannerStatus` TS type.
  const statusChangedUnlisten = await listen<{
    flightId: string;
    status: PlannerStatus;
  }>(`flight-planner:status-changed:${flightId}`, (event) => {
    const nextStatus = event.payload?.status;
    if (!nextStatus) return;
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, { status: nextStatus }),
    }));
  });

  // E3-FIX1 — refresh `flightStore` whenever the Rust planner tool
  // handlers mutate persisted flight state. Without these, the planner
  // populates PersistedState on disk but `MilestonesCard` / `TimelineCard`
  // stay empty until app reload, breaking the headline acceptance test.
  //
  // All 8 events are scoped to `flightId` and the Rust side emits them
  // unconditionally on success (see `commands/flight_planner_tools/*.rs`,
  // search for `format!("flight-planner:`). We call the existing
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
    "flight-completed",
    // E8-UI — sibling E8-ACCUM emits `flight-planner:cost-updated:<flightId>`
    // when the planner accumulates new tokens/cost. Same handling as the
    // other planner-side mutations: re-hydrate flightStore so StatGrid's
    // Planner / Exec cells reflect the latest numbers.
    "cost-updated",
  ] as const;
  const flightEventUnlistens: UnlistenFn[] = [];
  for (const kind of flightEventKinds) {
    const unlisten = await listen(`flight-planner:${kind}:${flightId}`, () => {
      // Best-effort re-read; surface failures to the console so we can
      // diagnose schema-drift issues without crashing the planner UI.
      void useFlightStore
        .getState()
        .hydrateFromBackend()
        .then(() => syncAsyncAttemptTerminalListeners())
        .catch((err) => {
          console.warn(
            `Failed to hydrate flightStore after flight-planner:${kind}`,
            flightId,
            err,
          );
        });
    });
    flightEventUnlistens.push(unlisten);
  }

  // E10 — context compaction events. The Rust planner fires
  // `compaction-triggered` when the 150K-token threshold is crossed and
  // it kicks off a Sonnet summarization pass; `compaction-completed`
  // when the new session has been swapped in and the priming summary is
  // live. We flip a transient `isCompacting` flag so the detail pane
  // can surface a "Compacting" pill, and on completion we re-hydrate
  // flightStore so any new journal entry / cost bump from the
  // summarization itself shows up immediately.
  const compactionTriggeredUnlisten = await listen(
    `flight-planner:compaction-triggered:${flightId}`,
    () => {
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, flightId, { isCompacting: true }),
      }));
    },
  );

  const compactionCompletedUnlisten = await listen(
    `flight-planner:compaction-completed:${flightId}`,
    () => {
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, flightId, { isCompacting: false }),
      }));
      void useFlightStore
        .getState()
        .hydrateFromBackend()
        .then(() => syncAsyncAttemptTerminalListeners())
        .catch((err) => {
          console.warn(
            "Failed to hydrate flightStore after flight-planner:compaction-completed",
            flightId,
            err,
          );
        });
    },
  );

  listenerCleanup.set(flightId, () => {
    chunkUnlisten();
    doneUnlisten();
    toolStartUnlisten();
    errorUnlisten();
    approvalRequestUnlisten();
    approvalResolvedUnlisten();
    rateLimitedUnlisten();
    statusChangedUnlisten();
    compactionTriggeredUnlisten();
    compactionCompletedUnlisten();
    for (const unlisten of flightEventUnlistens) {
      unlisten();
    }
  });
}

export const useFlightPlannerStore = create<FlightPlannerStore>((set, get) => ({
  runtimes: new Map(),
  pendingApprovals: new Map(),

  startPlanner: async (flightId, projectPath) => {
    const existing = get().runtimes.get(flightId);
    if (existing) return existing.plannerSessionId;

    // Choose the planner session id up front so we can install
    // `api-agent:*` listeners BEFORE the backend spawns the sidecar.
    // Otherwise any event emitted between `invokeStartFlightPlanner`
    // returning and `installListeners` resolving — including E3's spec-
    // mode greeting `chunk` events — is silently dropped.
    const provisionalSessionId = crypto.randomUUID();

    set((s) => {
      const runtimes = new Map(s.runtimes);
      runtimes.set(flightId, {
        flightId,
        plannerSessionId: provisionalSessionId,
        status: "awake",
        isStreaming: false,
        transcript: [],
        lastToolCall: null,
        awaitingLaunchKickoff: false,
        isCompacting: false,
      });
      return { runtimes };
    });
    await installListeners(flightId, provisionalSessionId, set);

    let plannerSessionId: string;
    try {
      plannerSessionId = await invokeStartFlightPlanner(
        flightId,
        projectPath,
        provisionalSessionId,
      );
    } catch (err) {
      // Tear down the listeners + provisional runtime so the next call
      // can re-issue cleanly. Otherwise a failed start leaves a zombie
      // runtime keyed to a never-spawned sidecar session.
      const cleanup = listenerCleanup.get(flightId);
      if (cleanup) {
        cleanup();
        listenerCleanup.delete(flightId);
      }
      set((s) => {
        if (!s.runtimes.has(flightId)) return {};
        const runtimes = new Map(s.runtimes);
        runtimes.delete(flightId);
        return { runtimes };
      });
      throw err;
    }

    // Defensive: confirm the backend honored the provisional id. If it
    // didn't (which would be a bug, given the new signature), re-install
    // listeners against the real id so events still route correctly.
    if (plannerSessionId !== provisionalSessionId) {
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, flightId, { plannerSessionId }),
      }));
      await installListeners(flightId, plannerSessionId, set);
    }

    // E3-LAUNCH / E3-HYD coordination — hydrate any pending approval
    // requests that were persisted by the Rust side. Live events will catch
    // new approvals; this only matters on app restart or view re-mount
    // while a planner is mid-flight. Non-fatal on error.
    try {
      const existing = await invokeGetFlightApprovals(flightId);
      if (existing.length > 0) {
        // Merge by id rather than replace: a live `approval-request`
        // event may have landed in the ~1ms gap between `installListeners`
        // resolving and this hydration call returning, and replacing the
        // map outright would drop those entries on the floor.
        set((s) => {
          return {
            pendingApprovals: mergePendingApprovals(s.pendingApprovals, flightId, existing, true),
          };
        });
      }
    } catch (err) {
      console.warn("Failed to hydrate pending approvals for flight", flightId, err);
    }

    return plannerSessionId;
  },

  stopPlanner: async (flightId) => {
    const cleanup = listenerCleanup.get(flightId);
    if (cleanup) {
      cleanup();
      listenerCleanup.delete(flightId);
    }
    set((s) => {
      const runtimes = new Map(s.runtimes);
      const pendingApprovals = new Map(s.pendingApprovals);
      const hadRuntime = runtimes.delete(flightId);
      const hadApprovals = pendingApprovals.delete(flightId);
      if (!hadRuntime && !hadApprovals) return {};
      return { runtimes, pendingApprovals };
    });
    try {
      await invokeStopFlightPlanner(flightId);
    } catch {
      // Best-effort: backend may already have torn the session down.
    }
  },

  pausePlanner: async (flightId) => {
    await invokePauseFlightPlanner(flightId);
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, { status: "paused" }),
    }));
  },

  resumePlanner: async (flightId) => {
    await invokeResumeFlightPlanner(flightId);
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, { status: "awake" }),
    }));
  },

  injectTurn: async (flightId, content, source) => {
    const ts = Date.now();
    set((s) => {
      const current = s.runtimes.get(flightId);
      if (!current) return {};
      return {
        runtimes: appendTranscript(s.runtimes, flightId, {
          role: source === "user" ? "user" : "system",
          content,
          ts,
        }),
      };
    });
    await invokeInjectPlannerTurn(flightId, content, source);
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, { isStreaming: true }),
    }));
  },

  launchFlight: async (flightId) => {
    const runtime = get().runtimes.get(flightId);
    if (!runtime) {
      throw new Error(
        `launchFlight: planner not started for flight ${flightId}. ` +
          "Call startPlanner first (spec-mode chat must be live).",
      );
    }

    // Optimistic system line so the user has visual feedback before the
    // planner's first stream chunk arrives.
    set((s) => ({
      runtimes: appendTranscript(s.runtimes, flightId, {
        role: "system",
        content: "Launching flight…",
        ts: Date.now(),
      }),
    }));

    // Flip `spec` -> `planning`. The detail pane (E3-MOUNT) listens on the
    // flight status to swap FlightSpecPane back to the milestones/timeline
    // view, so the user sees create_milestone / create_task calls land
    // live.
    useFlightStore.getState().updateFlight(flightId, { status: "planning" });

    // Arm the kickoff flag. The next `api-agent:tool-start` for this
    // planner consumes the flag and flips `planning -> active`. Done
    // AFTER the status flip and BEFORE the wake fires so a hypothetical
    // racing pre-launch tool can't accidentally trip the flip.
    set((s) => ({
      runtimes: patchRuntime(s.runtimes, flightId, {
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
      await invokeTriggerPlannerDecomposition(flightId);
    } catch (err) {
      // If the wake failed to enqueue, roll back the flight status,
      // disarm the kickoff flag, and clear the streaming indicator so
      // the user can retry. The optimistic "Launching flight…" line
      // stays in the transcript as a breadcrumb (the error event
      // listener may also append an `error:` line).
      useFlightStore.getState().updateFlight(flightId, { status: "spec" });
      set((s) => ({
        runtimes: patchRuntime(s.runtimes, flightId, {
          awaitingLaunchKickoff: false,
          isStreaming: false,
        }),
      }));
      throw err;
    }
  },

  getPlanner: (flightId) => get().runtimes.get(flightId),

  isPlannerRunning: (flightId) => {
    const runtime = get().runtimes.get(flightId);
    if (!runtime) return false;
    return runtime.status === "awake" || runtime.status === "idle";
  },

  resolveApproval: async (flightId, approvalId, choice) => {
    // Optimistically drop the approval from local state so the UI hides
    // immediately. If the backend call fails we restore it.
    let snapshot: FlightApprovalRequest[] | null = null;
    set((s) => {
      const list = s.pendingApprovals.get(flightId);
      if (!list || list.length === 0) return {};
      snapshot = list;
      const filtered = list.filter((a) => a.id !== approvalId);
      if (filtered.length === list.length) {
        snapshot = null;
        return {};
      }
      const pending = new Map(s.pendingApprovals);
      if (filtered.length === 0) {
        pending.delete(flightId);
      } else {
        pending.set(flightId, filtered);
      }
      return { pendingApprovals: pending };
    });

    try {
      await invokeResolveFlightApproval(approvalId, choice);
    } catch (err) {
      // Restore the snapshot so the user can retry.
      if (snapshot) {
        set((s) => {
          const pending = new Map(s.pendingApprovals);
          pending.set(flightId, snapshot as FlightApprovalRequest[]);
          return { pendingApprovals: pending };
        });
      }
      throw err;
    }
  },

  hydratePendingApprovals: async (flightId) => {
    const existing = await invokeGetFlightApprovals(flightId);
    set((s) => ({
      pendingApprovals: mergePendingApprovals(s.pendingApprovals, flightId, existing, false),
    }));
  },

  getPendingApprovals: (flightId) => {
    const list = get().pendingApprovals.get(flightId);
    if (!list || list.length === 0) return [];
    // Oldest-first.
    return [...list].sort((a, b) => a.awaitingSince - b.awaitingSince);
  },
}));
