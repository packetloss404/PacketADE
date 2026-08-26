import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  packetAgentRequest: vi.fn(),
  startPacketAgentStream: vi.fn(() => Promise.resolve()),
  stopPacketAgentStream: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import {
  packetAgentRequest,
  startPacketAgentStream,
  stopPacketAgentStream,
} from "@/lib/tauri";
import {
  ACK_BATCH_SIZE,
  ACK_QUIET_MS,
  FALLBACK_AFTER_FAILURES,
  POLL_INTERVAL_MS,
  usePacketAgentStore,
} from "@/stores/packetAgentStore";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

const mockRequest = vi.mocked(packetAgentRequest);
const mockStart = vi.mocked(startPacketAgentStream);
const mockStop = vi.mocked(stopPacketAgentStream);

const PACKAGE = {
  packageId: "packetade:f:worker",
  packageVersion: 1,
  integrity: { digest: `sha256:${"a".repeat(64)}` },
} as unknown as PacketAgentWorkerPackage;

let keyCounter = 0;

function seedDeployment(): string {
  const key = `key-${keyCounter += 1}`;
  usePacketAgentStore.getState().recordDeployment(key, PACKAGE, {
    status: 200,
    body: { deployment: { workerDeploymentId: `dep-${key}`, revision: 1, status: "deployed" } },
  });
  return key;
}

function ingest(key: string, eventId: string, eventType: string, data: Record<string, unknown> = {}) {
  usePacketAgentStore.getState().ingestStreamEvent(key, { eventId, eventType, data });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockRequest.mockReset();
  mockStart.mockClear();
  mockStop.mockClear();
  mockRequest.mockResolvedValue({ status: 200, body: {}, etag: "W/default" });
});

afterEach(async () => {
  vi.useRealTimers();
});

describe("packetAgentStore stream ingestion", () => {
  it("dedupes replayed event ids across reconnects", () => {
    const key = seedDeployment();
    ingest(key, "evt_01", "worker.run.approval_required");
    ingest(key, "evt_01", "worker.run.approval_required");
    const projection = usePacketAgentStore.getState().deployments[key];
    expect(projection.attentionCount).toBe(1);
    expect(projection.lastEventId).toBe("evt_01");
  });

  it("rejects out-of-order event ids", () => {
    const key = seedDeployment();
    ingest(key, "evt_05", "worker.activated");
    ingest(key, "evt_02", "worker.run.approval_required");
    const projection = usePacketAgentStore.getState().deployments[key];
    expect(projection.attentionCount).toBe(0);
    expect(projection.lastEventId).toBe("evt_05");
    expect(projection.status).toBe("active");
  });

  it("tolerates raw journal event type strings in projections", () => {
    const key = seedDeployment();
    ingest(key, "evt_01", "run.approval-required");
    ingest(key, "evt_02", "run.budget-exhausted");
    const projection = usePacketAgentStore.getState().deployments[key];
    expect(projection.attentionCount).toBe(1);
    expect(projection.status).toBe("budget_exhausted");
  });

  it("collects evidence event ids when evidence.available is true", () => {
    const key = seedDeployment();
    ingest(key, "evt_01", "worker.run.completed", { evidence: { available: true } });
    expect(usePacketAgentStore.getState().deployments[key].evidenceEventIds).toEqual(["evt_01"]);
  });
});

describe("packetAgentStore ack batching", () => {
  it("acks once after the quiet window with If-Match and idempotency key", async () => {
    const key = seedDeployment();
    usePacketAgentStore.getState().updateProjection(key, { cursorEtag: "W/1" });
    ingest(key, "evt_01", "worker.deployed");
    ingest(key, "evt_02", "worker.activated");
    expect(mockRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ACK_QUIET_MS + 10);
    const ackCalls = mockRequest.mock.calls.filter(([req]) => req.operation === "ack_events");
    expect(ackCalls).toHaveLength(1);
    const [ack] = ackCalls[0];
    expect(ack.payload).toEqual({ cursor: "evt_02" });
    expect(ack.ifMatch).toBe("W/1");
    expect(ack.idempotencyKey).toMatch(/^packetade:dep-.*:cursor:evt_02$/);
    expect(usePacketAgentStore.getState().deployments[key].cursor).toBe("evt_02");
  });

  it("acks immediately once the batch size is reached", async () => {
    const key = seedDeployment();
    usePacketAgentStore.getState().updateProjection(key, { cursorEtag: "W/1" });
    for (let index = 1; index <= ACK_BATCH_SIZE; index += 1) {
      ingest(key, `evt_${String(index).padStart(3, "0")}`, "worker.run.progress");
    }
    await flushMicrotasks();
    const ackCalls = mockRequest.mock.calls.filter(([req]) => req.operation === "ack_events");
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0][0].payload).toEqual({ cursor: `evt_${String(ACK_BATCH_SIZE).padStart(3, "0")}` });
  });

  it("treats 412 as refetch-page-then-re-ack, not an error", async () => {
    const key = seedDeployment();
    usePacketAgentStore.getState().updateProjection(key, { cursorEtag: "W/stale" });
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "ack_events" && req.ifMatch === "W/stale") {
        throw new Error("PacketAgent 412: cursor moved");
      }
      if (req.operation === "events") {
        return { status: 200, body: { events: [] }, etag: "W/fresh" };
      }
      return { status: 200, body: {}, etag: "W/fresh" };
    });
    ingest(key, "evt_01", "worker.deployed");
    await vi.advanceTimersByTimeAsync(ACK_QUIET_MS + 10);
    const ackCalls = mockRequest.mock.calls.filter(([req]) => req.operation === "ack_events");
    expect(ackCalls).toHaveLength(2);
    expect(ackCalls[1][0].ifMatch).toBe("W/fresh");
    expect(usePacketAgentStore.getState().deployments[key].cursor).toBe("evt_01");
  });
});

describe("packetAgentStore polling fallback", () => {
  it("flips to fixed multi-page polling after repeated connect failures", async () => {
    const key = seedDeployment();
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "events") {
        return { status: 200, body: { events: [], hasMore: false }, etag: "W/poll" };
      }
      return { status: 200, body: {} };
    });
    await usePacketAgentStore.getState().subscribe(key);
    expect(mockStart).toHaveBeenCalledTimes(1);

    for (let failure = 1; failure <= FALLBACK_AFTER_FAILURES; failure += 1) {
      usePacketAgentStore.getState().ingestStreamStatus(key, {
        state: "reconnecting",
        message: "connect refused",
        consecutiveFailures: failure,
      });
    }
    await flushMicrotasks();

    const status = usePacketAgentStore.getState().streamStatus[key];
    expect(status.mode).toBe("poll");
    expect(status.state).toBe("polling");
    expect(mockStop).toHaveBeenCalled();

    const pollsBefore = mockRequest.mock.calls.filter(([req]) => req.operation === "events").length;
    expect(pollsBefore).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10);
    const pollsAfter = mockRequest.mock.calls.filter(([req]) => req.operation === "events").length;
    expect(pollsAfter).toBeGreaterThan(pollsBefore);

    await usePacketAgentStore.getState().unsubscribe(key);
  });

  it("pages through events until hasMore is false", async () => {
    const key = seedDeployment();
    let page = 0;
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "events") {
        page += 1;
        if (page === 1) {
          return {
            status: 200,
            body: {
              events: [
                { id: "evt_01", type: "worker.deployed" },
                { id: "evt_02", type: "worker.activated" },
              ],
              hasMore: true,
            },
            etag: "W/p1",
          };
        }
        return {
          status: 200,
          body: { events: [{ id: "evt_03", type: "worker.run.approval_required" }], hasMore: false },
          etag: "W/p2",
        };
      }
      return { status: 200, body: {}, etag: "W/x" };
    });
    const applied = await usePacketAgentStore.getState().pollEventsOnce(key);
    expect(applied).toBe(3);
    const projection = usePacketAgentStore.getState().deployments[key];
    expect(projection.attentionCount).toBe(1);
    expect(projection.lastEventId).toBe("evt_03");
    // The poll pass acked the latest id explicitly.
    const ackCalls = mockRequest.mock.calls.filter(([req]) => req.operation === "ack_events");
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0][0].payload).toEqual({ cursor: "evt_03" });
  });
});
