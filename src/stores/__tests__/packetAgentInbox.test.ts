import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Flight } from "@/types/flight";

const mocks = vi.hoisted(() => ({
  saveFlightsSlice: vi.fn().mockResolvedValue(undefined),
  saveUiSlice: vi.fn().mockResolvedValue(undefined),
  loadPersistedState: vi.fn(),
  writePty: vi.fn().mockResolvedValue(undefined),
  packetAgentRequest: vi.fn().mockResolvedValue({ status: 200, body: {} }),
  startPacketAgentStream: vi.fn().mockResolvedValue(undefined),
  stopPacketAgentStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri", () => mocks);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/stores/agentTaskStore", () => ({
  useAgentTaskStore: {
    getState: () => ({ conversations: [], sendMessage: vi.fn() }),
    setState: vi.fn(),
  },
}));

import { parsePacketAgentDeepLink } from "@/lib/packetAgentCoordination";
import { postCoordinationMessage } from "@/stores/coordinationInboxStore";
import { buildPacketAgentCoordinationMessage } from "@/lib/packetAgentCoordination";
import { usePacketAgentStore } from "@/stores/packetAgentStore";
import { useFlightStore } from "@/stores/flightStore";
import type { PacketAgentWorkerPackage } from "@/types/packet-agent";

const PACKAGE = {
  packageId: "packetade:f:worker",
  packageVersion: 1,
  integrity: { digest: `sha256:${"a".repeat(64)}` },
} as unknown as PacketAgentWorkerPackage;

function flightFixture(id: string): Flight {
  return {
    id,
    title: "Inbox flight",
    objective: "Coordinate",
    status: "active",
    priority: "medium",
    projectPath: "/repo",
    workspaceId: null,
    milestones: [],
    linkedSessionIds: [],
    issueIds: [],
    createdAt: 1,
    updatedAt: 1,
    totalCost: 0,
    totalTokens: 0,
    coordinationInbox: [],
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  mocks.packetAgentRequest.mockResolvedValue({ status: 200, body: {} });
});

describe("PacketAgent → coordination inbox", () => {
  it("posts one inbox message per attention event, deduped on replay", async () => {
    const flightId = "flight-inbox-1";
    useFlightStore.setState({ flights: [flightFixture(flightId)] });
    usePacketAgentStore.getState().recordDeployment(flightId, PACKAGE, {
      status: 200,
      body: { deployment: { workerDeploymentId: "dep-inbox", revision: 1, status: "active" } },
    });

    const message = buildPacketAgentCoordinationMessage({
      flightId,
      deploymentId: "dep-inbox",
      workerRunId: "run-1",
      event: {
        eventId: "evt_att_1",
        type: "worker.run.approval_required",
        data: { attentionRequestId: "att-1" },
      },
    });
    expect(message).toBeDefined();
    // Same event posted twice (e.g. SSE frame + fallback poll) = one message.
    await postCoordinationMessage(message!);
    await postCoordinationMessage(message!);

    const inbox =
      useFlightStore.getState().flights.find((f) => f.id === flightId)?.coordinationInbox ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0].dedupeKey).toBe("packetagent:evt_att_1");
    expect(inbox[0].kind).toBe("blocker");
    const link = parsePacketAgentDeepLink(inbox[0].artifacts[0]?.uri);
    expect(link?.deploymentId).toBe("dep-inbox");
    expect(link?.attentionRequestId).toBe("att-1");
  });

  it("ingesting an attention event through the store lands in the flight inbox", async () => {
    const flightId = "flight-inbox-2";
    useFlightStore.setState({ flights: [flightFixture(flightId)] });
    usePacketAgentStore.getState().recordDeployment(flightId, PACKAGE, {
      status: 200,
      body: { deployment: { workerDeploymentId: "dep-inbox-2", revision: 1, status: "active" } },
    });

    usePacketAgentStore.getState().ingestStreamEvent(flightId, {
      eventId: "evt_term_1",
      eventType: "worker.run.failed",
      data: {},
    });
    await flushMicrotasks();
    // The lazy import resolves asynchronously; give it one more turn.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const inbox =
      useFlightStore.getState().flights.find((f) => f.id === flightId)?.coordinationInbox ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0].kind).toBe("blocker");
    expect(inbox[0].dedupeKey).toBe("packetagent:evt_term_1");
  });
});
