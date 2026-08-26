import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { APP_NAME_LOWER, storageKey } from "@/lib/brand";
import { parsePacketAgentAttentionList } from "@/lib/packetAgentAttention";
import { buildPacketAgentCoordinationMessage } from "@/lib/packetAgentCoordination";
import {
  isPacketAgentAttentionEvent,
  projectPacketAgentEvent,
  type ObservedPacketAgentEvent,
} from "@/lib/packetAgentProjection";
import {
  packetAgentRequest,
  startPacketAgentStream,
  stopPacketAgentStream,
  type PacketAgentStreamEventPayload,
  type PacketAgentStreamStatusPayload,
} from "@/lib/tauri";
import type {
  PacketAgentAttentionDecision,
  PacketAgentAttentionRequest,
  PacketAgentDeploymentProjection,
  PacketAgentResponse,
  PacketAgentWorkerPackage,
} from "@/types/packet-agent";

// === Tunables ===============================================================

/** Ack after this many un-acked events… */
export const ACK_BATCH_SIZE = 20;
/** …or after this long with no new event, whichever comes first. */
export const ACK_QUIET_MS = 3_000;
/** Consecutive SSE connect failures before flipping to page polling. */
export const FALLBACK_AFTER_FAILURES = 3;
/** Fallback polling cadence. */
export const POLL_INTERVAL_MS = 30_000;
/** While polling, retry SSE this often. */
export const SSE_RETRY_MS = 300_000;
/** Safety cap on pages fetched by one poll pass. */
const MAX_POLL_PAGES = 20;

export type PacketAgentStreamMode = "sse" | "poll";

export interface PacketAgentStreamStatus {
  state: "idle" | "connected" | "reconnecting" | "stopped" | "error" | "polling";
  mode: PacketAgentStreamMode;
  message?: string;
  consecutiveFailures: number;
}

// === Per-subscription runtime (never persisted) =============================

interface SubscriptionRuntime {
  key: string;
  deploymentId: string;
  unlisten: UnlistenFn[];
  /** Event ids observed since subscribe — reconnect dedupe. */
  seen: Set<string>;
  pendingAckEventId?: string;
  unackedCount: number;
  ackTimer?: ReturnType<typeof setTimeout>;
  ackInFlight: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  sseRetryTimer?: ReturnType<typeof setTimeout>;
  mode: PacketAgentStreamMode;
}

const runtimes = new Map<string, SubscriptionRuntime>();

function clearRuntimeTimers(runtime: SubscriptionRuntime): void {
  if (runtime.ackTimer) clearTimeout(runtime.ackTimer);
  if (runtime.pollTimer) clearInterval(runtime.pollTimer);
  if (runtime.sseRetryTimer) clearTimeout(runtime.sseRetryTimer);
  runtime.ackTimer = undefined;
  runtime.pollTimer = undefined;
  runtime.sseRetryTimer = undefined;
}

// === Store ==================================================================

interface PacketAgentStore {
  endpoint: string;
  workspaceId: string;
  deployments: Record<string, PacketAgentDeploymentProjection>;
  /** PH6: live stream/poll status per projection key. Not persisted. */
  streamStatus: Record<string, PacketAgentStreamStatus>;
  /** PH7: open attention requests per projection key. Not persisted. */
  attention: Record<string, PacketAgentAttentionRequest[]>;
  setConnection: (endpoint: string, workspaceId: string) => void;
  removeDeployment: (key: string) => void;
  updateProjection: (key: string, updates: Partial<PacketAgentDeploymentProjection>) => void;
  request: (
    operation: Parameters<typeof packetAgentRequest>[0]["operation"],
    options?: Omit<
      Parameters<typeof packetAgentRequest>[0],
      "endpoint" | "workspaceId" | "operation"
    >,
  ) => Promise<PacketAgentResponse>;
  recordDeployment: (
    key: string,
    workerPackage: PacketAgentWorkerPackage,
    response: PacketAgentResponse,
  ) => PacketAgentDeploymentProjection;
  mergeProjection: (
    key: string,
    response: PacketAgentResponse,
  ) => PacketAgentDeploymentProjection | undefined;
  /** PH6: open the Rust SSE consumer for this deployment and project its
   * events. Idempotent per key. */
  subscribe: (key: string) => Promise<void>;
  /** PH6: stop the stream, timers, and listeners for this key. */
  unsubscribe: (key: string) => Promise<void>;
  /** PH6: ingest one observed event (SSE frame or poll row). Dedupes on
   * event id, rejects out-of-order ids, schedules batched acks. Exposed on
   * the store so tests can drive it directly. */
  ingestStreamEvent: (key: string, payload: PacketAgentStreamEventPayload) => void;
  /** PH6: ingest a stream-status transition; flips to polling fallback after
   * FALLBACK_AFTER_FAILURES consecutive connect failures. */
  ingestStreamStatus: (key: string, payload: PacketAgentStreamStatusPayload) => void;
  /** PH6: flush the pending batched ack now (also used by tests). */
  flushAck: (key: string) => Promise<void>;
  /** PH6: one multi-page events poll pass (fallback path / manual sync).
   * Returns the number of newly-applied events. */
  pollEventsOnce: (key: string) => Promise<number>;
  /** PH7: refresh the open attention list for this deployment. Called
   * automatically when an approval_required/blocked event is observed. */
  fetchAttention: (key: string) => Promise<void>;
  /** PH7: approve/reject one attention request with an idempotency key of
   * the form packetbench:{attentionId}:{decision}:{revision}. A stale
   * expectedRevision (409/412) refetches the attention list and rethrows. */
  respondAttention: (
    key: string,
    attentionId: string,
    decision: PacketAgentAttentionDecision,
  ) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const found = record(value)?.[key];
  return typeof found === "string" ? found : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  const found = record(value)?.[key];
  return typeof found === "number" ? found : undefined;
}

function deploymentFields(body: Record<string, unknown>) {
  const deployment = record(body.deployment) ?? record(body.control);
  const resultingIds = record(body.resultingIds);
  return {
    deploymentId:
      stringAt(resultingIds, "workerDeploymentId") ??
      stringAt(deployment, "workerDeploymentId") ??
      stringAt(deployment, "id"),
    workerRunId:
      stringAt(resultingIds, "workerRunId") ?? stringAt(record(body.activation), "workerRunId"),
    revision: numberAt(deployment, "revision"),
    status: stringAt(deployment, "status"),
  };
}

export const DEFAULT_PACKET_AGENT_ENDPOINT = "http://127.0.0.1:8484";
/** Pre-v1 default that pointed at the wrong port; migrated on hydrate. */
const STALE_DEFAULT_ENDPOINT = "http://127.0.0.1:8787";

type PersistedPacketAgentState = {
  endpoint: string;
  workspaceId: string;
  deployments: Record<string, PacketAgentDeploymentProjection>;
};

/**
 * One-time persisted-state migration: the pre-v1 default endpoint pointed at
 * port 8787, which PacketAgent never listens on (server default is
 * PORT ?? 8484). Only the exact stale default is rewritten — any other
 * persisted endpoint was user-typed and is left alone.
 */
export function migratePacketAgentPersistedState(
  persisted: unknown,
  version: number,
): PersistedPacketAgentState {
  const state = persisted as PersistedPacketAgentState;
  if (version === 0 && state?.endpoint === STALE_DEFAULT_ENDPOINT) {
    return { ...state, endpoint: DEFAULT_PACKET_AGENT_ENDPOINT };
  }
  return state;
}

/** Extract {events, hasMore} from an events-page body. */
function eventPage(body: unknown): { events: Array<Record<string, unknown>>; hasMore: boolean } {
  const root = record(body);
  const events = Array.isArray(root?.events)
    ? root.events.filter((event): event is Record<string, unknown> => Boolean(record(event)))
    : [];
  return { events, hasMore: root?.hasMore === true };
}

function normalizeObservedEvent(
  payload: PacketAgentStreamEventPayload,
): ObservedPacketAgentEvent | undefined {
  const data = record(payload.data) ?? {};
  const eventId = payload.eventId ?? stringAt(data, "id");
  const type = payload.eventType ?? stringAt(data, "type");
  if (!type) return undefined;
  return { eventId, type, data };
}

function is412(error: unknown): boolean {
  return String(error).includes("PacketAgent 412");
}

export const usePacketAgentStore = create<PacketAgentStore>()(
  persist(
    (set, get) => ({
      endpoint: DEFAULT_PACKET_AGENT_ENDPOINT,
      workspaceId: "",
      deployments: {},
      streamStatus: {},
      attention: {},
      setConnection: (endpoint, workspaceId) =>
        set({ endpoint: endpoint.trim().replace(/\/+$/, ""), workspaceId: workspaceId.trim() }),
      removeDeployment: (key) => {
        void get().unsubscribe(key);
        set((state) => {
          const deployments = { ...state.deployments };
          delete deployments[key];
          const streamStatus = { ...state.streamStatus };
          delete streamStatus[key];
          const attention = { ...state.attention };
          delete attention[key];
          return { deployments, streamStatus, attention };
        });
      },
      updateProjection: (key, updates) =>
        set((state) => {
          const current = state.deployments[key];
          if (!current) return {};
          return {
            deployments: {
              ...state.deployments,
              [key]: { ...current, ...updates, updatedAt: Date.now() },
            },
          };
        }),
      request: (operation, options = {}) => {
        const { endpoint, workspaceId } = get();
        return packetAgentRequest({ endpoint, workspaceId, operation, ...options });
      },
      recordDeployment: (key, workerPackage, response) => {
        const fields = deploymentFields(response.body);
        if (!fields.deploymentId) {
          throw new Error("PacketAgent response did not include a worker deployment ID.");
        }
        const projection: PacketAgentDeploymentProjection = {
          flightId: key,
          packageId: workerPackage.packageId,
          packageVersion: workerPackage.packageVersion,
          packageDigest: workerPackage.integrity.digest,
          deploymentId: fields.deploymentId,
          workerRunId: fields.workerRunId,
          revision: fields.revision ?? 1,
          status: fields.status ?? "deployed",
          attentionCount: 0,
          evidenceEventIds: [],
          updatedAt: Date.now(),
        };
        set((state) => ({
          deployments: { ...state.deployments, [key]: projection },
        }));
        return projection;
      },
      mergeProjection: (key, response) => {
        const current = get().deployments[key];
        if (!current) return undefined;
        const fields = deploymentFields(response.body);
        const next: PacketAgentDeploymentProjection = {
          ...current,
          ...(fields.deploymentId ? { deploymentId: fields.deploymentId } : {}),
          ...(fields.workerRunId ? { workerRunId: fields.workerRunId } : {}),
          ...(fields.revision ? { revision: fields.revision } : {}),
          ...(fields.status ? { status: fields.status } : {}),
          updatedAt: Date.now(),
        };
        set((state) => ({ deployments: { ...state.deployments, [key]: next } }));
        return next;
      },

      subscribe: async (key) => {
        const projection = get().deployments[key];
        if (!projection?.deploymentId || runtimes.has(key)) return;
        const deploymentId = projection.deploymentId;
        const runtime: SubscriptionRuntime = {
          key,
          deploymentId,
          unlisten: [],
          seen: new Set(),
          unackedCount: 0,
          ackInFlight: false,
          mode: "sse",
        };
        runtimes.set(key, runtime);
        try {
          runtime.unlisten.push(
            await listen<PacketAgentStreamEventPayload>(
              `packet-agent:event:${deploymentId}`,
              (event) => get().ingestStreamEvent(key, event.payload),
            ),
            await listen<PacketAgentStreamStatusPayload>(
              `packet-agent:stream-status:${deploymentId}`,
              (event) => get().ingestStreamStatus(key, event.payload),
            ),
          );
          const { endpoint, workspaceId } = get();
          await startPacketAgentStream({
            endpoint,
            workspaceId,
            deploymentId,
            cursor: projection.cursor,
          });
          set((state) => ({
            streamStatus: {
              ...state.streamStatus,
              [key]: { state: "reconnecting", mode: "sse", consecutiveFailures: 0 },
            },
          }));
        } catch (error) {
          // Stream start failed outright (missing token, bad endpoint):
          // fall straight into the polling fallback.
          set((state) => ({
            streamStatus: {
              ...state.streamStatus,
              [key]: {
                state: "polling",
                mode: "poll",
                message: String(error),
                consecutiveFailures: FALLBACK_AFTER_FAILURES,
              },
            },
          }));
          enterPollingFallback(get, set, key);
        }
      },

      unsubscribe: async (key) => {
        const runtime = runtimes.get(key);
        if (!runtime) return;
        runtimes.delete(key);
        clearRuntimeTimers(runtime);
        for (const unlisten of runtime.unlisten) unlisten();
        set((state) => ({
          streamStatus: {
            ...state.streamStatus,
            [key]: { state: "idle", mode: runtime.mode, consecutiveFailures: 0 },
          },
        }));
        try {
          await stopPacketAgentStream(runtime.deploymentId);
        } catch {
          // The task may already be gone; stopping is best-effort.
        }
      },

      ingestStreamEvent: (key, payload) => {
        const projection = get().deployments[key];
        if (!projection) return;
        const observed = normalizeObservedEvent(payload);
        if (!observed) return;
        const runtime = ensureRuntime(key, projection.deploymentId);
        if (observed.eventId) {
          // Dedupe (reconnect replays) + out-of-order rejection. Event ids
          // are server-ordered; the durable cursor and the last projected id
          // both upper-bound what we have already applied.
          if (runtime.seen.has(observed.eventId)) return;
          const floor = projection.lastEventId ?? projection.cursor;
          if (floor && observed.eventId <= floor) return;
          runtime.seen.add(observed.eventId);
          if (runtime.seen.size > 5_000) runtime.seen.clear();
        }
        const updates = projectPacketAgentEvent(projection, observed);
        get().updateProjection(key, updates);
        // PH7: an approval_required/blocked event means there is (probably) a
        // new open attention request — fetch the authoritative list.
        if (isPacketAgentAttentionEvent(observed.type)) {
          void get()
            .fetchAttention(key)
            .catch(() => undefined);
        }
        // PH9: attention/terminal events also post into the flight's
        // coordination inbox (dedupeKey packetagent:{eventId}). Lazy import
        // keeps the flight-store graph out of this module; a key that is not
        // a Flight id (conversation deployments) rejects and is ignored.
        const inboxMessage = buildPacketAgentCoordinationMessage({
          flightId: key,
          deploymentId: projection.deploymentId,
          workerRunId: projection.workerRunId,
          event: observed,
        });
        if (inboxMessage) {
          void import("@/stores/coordinationInboxStore")
            .then((module) => module.postCoordinationMessage(inboxMessage))
            .catch(() => undefined);
        }
        if (observed.eventId) {
          runtime.pendingAckEventId = observed.eventId;
          runtime.unackedCount += 1;
          if (runtime.unackedCount >= ACK_BATCH_SIZE) {
            void get().flushAck(key);
          } else {
            if (runtime.ackTimer) clearTimeout(runtime.ackTimer);
            runtime.ackTimer = setTimeout(() => {
              void get().flushAck(key);
            }, ACK_QUIET_MS);
          }
        }
      },

      ingestStreamStatus: (key, payload) => {
        const runtime = runtimes.get(key);
        // Status after unsubscribe (e.g. the "stopped" echo of our own stop
        // command) is noise — the projection key is no longer live.
        if (!runtime) return;
        set((state) => ({
          streamStatus: {
            ...state.streamStatus,
            [key]: {
              // While in the polling fallback the Rust task is intentionally
              // stopped; its transitions must not repaint the poll status.
              state: runtime.mode === "poll" ? "polling" : payload.state,
              mode: runtime.mode,
              message: payload.message,
              consecutiveFailures: payload.consecutiveFailures,
            },
          },
        }));
        if (
          runtime.mode === "sse" &&
          payload.state === "reconnecting" &&
          payload.consecutiveFailures >= FALLBACK_AFTER_FAILURES
        ) {
          enterPollingFallback(get, set, key);
        }
      },

      flushAck: async (key) => {
        const runtime = runtimes.get(key);
        const projection = get().deployments[key];
        if (!runtime || !projection) return;
        const eventId = runtime.pendingAckEventId;
        if (!eventId || runtime.ackInFlight) return;
        if (projection.cursor === eventId) {
          runtime.unackedCount = 0;
          return;
        }
        runtime.ackInFlight = true;
        if (runtime.ackTimer) {
          clearTimeout(runtime.ackTimer);
          runtime.ackTimer = undefined;
        }
        const deploymentId = projection.deploymentId;
        const ackOnce = async (ifMatch: string) => {
          const acknowledged = await get().request("ack_events", {
            deploymentId,
            payload: { cursor: eventId },
            idempotencyKey: `${APP_NAME_LOWER}:${deploymentId}:cursor:${eventId}`,
            ifMatch,
          });
          const cursorRecord = record(record(acknowledged.body)?.cursor);
          get().updateProjection(key, {
            cursor: eventId,
            cursorEtag: acknowledged.etag ?? stringAt(cursorRecord, "etag"),
          });
          runtime.unackedCount = 0;
          if (runtime.pendingAckEventId === eventId) runtime.pendingAckEventId = undefined;
        };
        const freshEtag = async (): Promise<string | undefined> => {
          const page = await get().request("events", {
            deploymentId,
            cursor: get().deployments[key]?.cursor,
          });
          return page.etag;
        };
        try {
          let etag = projection.cursorEtag;
          if (!etag) etag = await freshEtag();
          if (!etag) return;
          try {
            await ackOnce(etag);
          } catch (error) {
            if (!is412(error)) throw error;
            // Stale cursor ETag — refetch the page for the fresh one and
            // re-ack exactly once. A second 412 is surfaced as an error.
            const retryEtag = await freshEtag();
            if (retryEtag) await ackOnce(retryEtag);
          }
        } catch (error) {
          set((state) => ({
            streamStatus: {
              ...state.streamStatus,
              [key]: {
                ...(state.streamStatus[key] ?? {
                  state: "error",
                  mode: runtime.mode,
                  consecutiveFailures: 0,
                }),
                message: `Ack failed: ${String(error)}`,
              },
            },
          }));
        } finally {
          runtime.ackInFlight = false;
        }
      },

      pollEventsOnce: async (key) => {
        const projection = get().deployments[key];
        if (!projection) return 0;
        const runtime = ensureRuntime(key, projection.deploymentId);
        const deploymentId = projection.deploymentId;
        try {
          const inspected = await get().request("inspect", { deploymentId });
          get().mergeProjection(key, inspected);
        } catch {
          // Inspect is informational; the events pages are the payload.
        }
        let applied = 0;
        let cursor = get().deployments[key]?.cursor;
        for (let page = 0; page < MAX_POLL_PAGES; page += 1) {
          let response: PacketAgentResponse;
          try {
            response = await get().request("events", { deploymentId, cursor });
          } catch (error) {
            set((state) => ({
              streamStatus: {
                ...state.streamStatus,
                [key]: {
                  ...(state.streamStatus[key] ?? {
                    state: "polling",
                    mode: runtime.mode,
                    consecutiveFailures: 0,
                  }),
                  message: `Event poll failed: ${String(error)}`,
                },
              },
            }));
            break;
          }
          const { events, hasMore } = eventPage(response.body);
          if (response.etag) {
            get().updateProjection(key, { cursorEtag: response.etag });
          }
          let lastId: string | undefined;
          for (const row of events) {
            const id = stringAt(row, "id");
            const type = stringAt(row, "type");
            if (!type) continue;
            const before = get().deployments[key];
            if (!before) break;
            const alreadySeen = Boolean(id && runtime.seen.has(id));
            get().ingestStreamEvent(key, { eventId: id, eventType: type, data: row });
            if (id) lastId = id;
            if (id && !alreadySeen) applied += 1;
          }
          if (lastId) cursor = lastId;
          if (!hasMore || events.length === 0) break;
        }
        if (applied > 0) await get().flushAck(key);
        return applied;
      },

      fetchAttention: async (key) => {
        const projection = get().deployments[key];
        if (!projection) return;
        const response = await get().request("attention", {
          deploymentId: projection.deploymentId,
        });
        const open = parsePacketAgentAttentionList(response.body);
        set((state) => ({ attention: { ...state.attention, [key]: open } }));
      },

      respondAttention: async (key, attentionId, decision) => {
        const projection = get().deployments[key];
        if (!projection) throw new Error("Unknown PacketAgent deployment.");
        const request = (get().attention[key] ?? []).find((entry) => entry.id === attentionId);
        const expectedRevision = request?.revision ?? 1;
        try {
          await get().request("respond_attention", {
            attentionId,
            payload: { decision, expectedRevision },
            idempotencyKey: `${APP_NAME_LOWER}:${attentionId}:${decision}:${expectedRevision}`,
          });
          // Optimistically drop the answered request; the follow-up fetch is
          // authoritative.
          set((state) => ({
            attention: {
              ...state.attention,
              [key]: (state.attention[key] ?? []).filter((entry) => entry.id !== attentionId),
            },
          }));
          void get()
            .fetchAttention(key)
            .catch(() => undefined);
        } catch (error) {
          const message = String(error);
          if (message.includes("PacketAgent 409") || message.includes("PacketAgent 412")) {
            // Stale expectedRevision — someone else answered or the run
            // moved. Refresh the list so the card shows current reality.
            await get()
              .fetchAttention(key)
              .catch(() => undefined);
          }
          throw error;
        }
      },
    }),
    {
      name: storageKey("packet-agent"),
      version: 1,
      migrate: migratePacketAgentPersistedState,
      partialize: ({ endpoint, workspaceId, deployments }) => ({
        endpoint,
        workspaceId,
        deployments,
      }),
    },
  ),
);

function ensureRuntime(key: string, deploymentId: string): SubscriptionRuntime {
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = {
      key,
      deploymentId,
      unlisten: [],
      seen: new Set(),
      unackedCount: 0,
      ackInFlight: false,
      mode: "sse",
    };
    runtimes.set(key, runtime);
  }
  return runtime;
}

/** Flip one subscription to fixed-interval multi-page polling; retry SSE
 * every SSE_RETRY_MS. The Rust task is stopped so it does not keep burning
 * reconnect attempts underneath the poller. */
function enterPollingFallback(
  get: () => PacketAgentStore,
  set: (partial: Partial<PacketAgentStore> | ((state: PacketAgentStore) => Partial<PacketAgentStore>)) => void,
  key: string,
): void {
  const runtime = runtimes.get(key);
  if (!runtime || runtime.mode === "poll") return;
  runtime.mode = "poll";
  void stopPacketAgentStream(runtime.deploymentId).catch(() => undefined);
  set((state) => ({
    streamStatus: {
      ...state.streamStatus,
      [key]: {
        ...(state.streamStatus[key] ?? { consecutiveFailures: 0 }),
        state: "polling",
        mode: "poll",
        consecutiveFailures: state.streamStatus[key]?.consecutiveFailures ?? 0,
      },
    },
  }));
  void get().pollEventsOnce(key);
  runtime.pollTimer = setInterval(() => {
    void get().pollEventsOnce(key);
  }, POLL_INTERVAL_MS);
  runtime.sseRetryTimer = setTimeout(() => {
    void retrySse(get, set, key);
  }, SSE_RETRY_MS);
}

async function retrySse(
  get: () => PacketAgentStore,
  set: (partial: Partial<PacketAgentStore> | ((state: PacketAgentStore) => Partial<PacketAgentStore>)) => void,
  key: string,
): Promise<void> {
  const runtime = runtimes.get(key);
  const projection = get().deployments[key];
  if (!runtime || !projection) return;
  if (runtime.pollTimer) clearInterval(runtime.pollTimer);
  runtime.pollTimer = undefined;
  runtime.sseRetryTimer = undefined;
  runtime.mode = "sse";
  set((state) => ({
    streamStatus: {
      ...state.streamStatus,
      [key]: {
        ...(state.streamStatus[key] ?? { consecutiveFailures: 0 }),
        state: "reconnecting",
        mode: "sse",
        consecutiveFailures: 0,
      },
    },
  }));
  try {
    const { endpoint, workspaceId } = get();
    await startPacketAgentStream({
      endpoint,
      workspaceId,
      deploymentId: runtime.deploymentId,
      cursor: projection.cursor,
    });
  } catch {
    enterPollingFallback(get, set, key);
  }
}
