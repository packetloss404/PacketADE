import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  packetAgentRequest: vi.fn(),
  startPacketAgentStream: vi.fn(() => Promise.resolve()),
  stopPacketAgentStream: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { packetAgentRequest } from "@/lib/tauri";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

const mockRequest = vi.mocked(packetAgentRequest);

const PACKAGE = {
  packageId: "packetade:f:worker",
  packageVersion: 1,
  integrity: { digest: `sha256:${"a".repeat(64)}` },
} as unknown as PacketAgentWorkerPackage;

const ATTENTION_ROW = {
  id: "att-1",
  workerDeploymentId: "dep-1",
  workerRunId: "run-1",
  status: "open",
  summary: "Wants to push a branch",
  operation: { tool: "git", verbs: ["push"], effect: "write", resources: ["repo://origin"] },
  revision: 4,
};

let keyCounter = 100;

function seedDeployment(): string {
  const key = `att-key-${keyCounter += 1}`;
  usePacketAgentStore.getState().recordDeployment(key, PACKAGE, {
    status: 200,
    body: { deployment: { workerDeploymentId: `dep-${key}`, revision: 1, status: "active" } },
  });
  return key;
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ status: 200, body: {} });
});

describe("packetAgentStore attention", () => {
  it("fetches open attention when an approval_required event arrives", async () => {
    const key = seedDeployment();
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "attention") {
        return { status: 200, body: { attention: [ATTENTION_ROW] } };
      }
      return { status: 200, body: {}, etag: "W/1" };
    });
    usePacketAgentStore.getState().ingestStreamEvent(key, {
      eventId: "evt_01",
      eventType: "worker.run.approval_required",
      data: {},
    });
    await flushMicrotasks();
    const open = usePacketAgentStore.getState().attention[key];
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe("att-1");
    expect(open[0].operation?.verb).toBe("push");
    expect(open[0].revision).toBe(4);
    const attentionCalls = mockRequest.mock.calls.filter(([req]) => req.operation === "attention");
    expect(attentionCalls).toHaveLength(1);
  });

  it("responds with the record's revision and a deterministic idempotency key", async () => {
    const key = seedDeployment();
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "attention") {
        return { status: 200, body: { attention: [ATTENTION_ROW] } };
      }
      return { status: 200, body: {} };
    });
    await usePacketAgentStore.getState().fetchAttention(key);
    await usePacketAgentStore.getState().respondAttention(key, "att-1", "approve_once");
    const respondCalls = mockRequest.mock.calls.filter(
      ([req]) => req.operation === "respond_attention",
    );
    expect(respondCalls).toHaveLength(1);
    const [respond] = respondCalls[0];
    expect(respond.attentionId).toBe("att-1");
    expect(respond.payload).toEqual({ decision: "approve_once", expectedRevision: 4 });
    expect(respond.idempotencyKey).toBe("packetade:att-1:approve_once:4");
  });

  it("uses the identical idempotency key on a replayed decision", async () => {
    const key = seedDeployment();
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "attention") {
        return { status: 200, body: { attention: [ATTENTION_ROW] } };
      }
      return { status: 200, body: {} };
    });
    await usePacketAgentStore.getState().fetchAttention(key);
    await usePacketAgentStore.getState().respondAttention(key, "att-1", "reject");
    // The list refetch restores the row; replaying the same decision must
    // produce the same idempotency key so the server can dedupe it.
    await flushMicrotasks();
    await usePacketAgentStore.getState().respondAttention(key, "att-1", "reject");
    const keys = mockRequest.mock.calls
      .filter(([req]) => req.operation === "respond_attention")
      .map(([req]) => req.idempotencyKey);
    expect(keys).toEqual(["packetade:att-1:reject:4", "packetade:att-1:reject:4"]);
  });

  it("treats a stale revision as refetch-and-rethrow", async () => {
    const key = seedDeployment();
    let attentionFetches = 0;
    mockRequest.mockImplementation(async (req) => {
      if (req.operation === "attention") {
        attentionFetches += 1;
        return {
          status: 200,
          body: { attention: attentionFetches > 1 ? [] : [ATTENTION_ROW] },
        };
      }
      if (req.operation === "respond_attention") {
        throw new Error("PacketAgent 409: stale revision");
      }
      return { status: 200, body: {} };
    });
    await usePacketAgentStore.getState().fetchAttention(key);
    await expect(
      usePacketAgentStore.getState().respondAttention(key, "att-1", "approve_for_run"),
    ).rejects.toThrow(/409/);
    expect(attentionFetches).toBe(2);
    expect(usePacketAgentStore.getState().attention[key]).toEqual([]);
  });
});
